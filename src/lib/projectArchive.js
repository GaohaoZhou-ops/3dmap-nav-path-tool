import { strFromU8, strToU8, unzip, zip } from 'fflate';

export const PROJECT_ARCHIVE_FORMAT = 'atlas-route-studio-project';
export const PROJECT_ARCHIVE_VERSION = 1;
export const PROJECT_ARCHIVE_MANIFEST = 'manifest.json';
export const PROJECT_ARCHIVE_CONFIG = 'config/project.json';

const textBytes = (value) => strToU8(String(value));

const jsonBytes = (value) => textBytes(JSON.stringify(value, null, 2));

const base64ToBytes = (value) => {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) return new Uint8Array();
  const binary = globalThis.atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
};

const dataUrlToAsset = (value, fallbackMimeType = 'application/octet-stream') => {
  const source = String(value || '');
  const separator = source.indexOf(',');
  if (!source.startsWith('data:') || separator < 5) {
    throw new Error('视觉快照不是有效的 Data URL');
  }
  const header = source.slice(5, separator);
  const body = source.slice(separator + 1);
  const parts = header.split(';');
  const mimeType = parts[0] || fallbackMimeType;
  const bytes = parts.includes('base64')
    ? base64ToBytes(body)
    : textBytes(decodeURIComponent(body));
  return { bytes, mimeType };
};

const imageExtension = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('gif')) return 'gif';
  return 'bin';
};

export const sanitizeArchiveSegment = (value, fallback = 'unnamed') => {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[. _]+|[. _]+$/g, '')
    .slice(0, 56);
  return normalized || fallback;
};

const indexedFolder = (index, name, fallback) => (
  `${String(index + 1).padStart(2, '0')}_${sanitizeArchiveSegment(name, fallback)}`
);

const addEntry = (entries, path, bytes, compressionLevel = 6) => {
  entries[path] = [bytes, { level: compressionLevel }];
};

const externalizeImage = (image, pathStem, entries, statistics, kind) => {
  if (!image || typeof image !== 'object' || !image.dataUrl) return image || null;
  const asset = dataUrlToAsset(image.dataUrl, image.mimeType || 'image/png');
  const path = `${pathStem}.${imageExtension(asset.mimeType)}`;
  addEntry(entries, path, asset.bytes, 0);
  statistics.assetByteLength += asset.bytes.byteLength;
  if (kind === 'rgb') statistics.rgbFileCount += 1;
  else statistics.previewFileCount += 1;
  const { dataUrl, ...metadata } = image;
  return {
    ...metadata,
    encoding: 'archive-file',
    mimeType: asset.mimeType,
    byteLength: asset.bytes.byteLength,
    file: path,
  };
};

const externalizePointCloud = (pointCloud, cloudRoot, entries, statistics) => {
  if (!pointCloud || typeof pointCloud !== 'object') return null;
  const {
    positionData,
    colorData,
    preview,
    ...metadata
  } = pointCloud;
  const external = {
    ...metadata,
    positionEncoding: String(pointCloud.positionEncoding || 'uint16-le/base64')
      .replace(/\/base64$/i, ''),
    colorEncoding: String(pointCloud.colorEncoding || 'rgb8/base64')
      .replace(/\/base64$/i, ''),
  };

  if (positionData) {
    const positionBytes = base64ToBytes(positionData);
    external.positionFile = `${cloudRoot}/positions.u16le`;
    addEntry(entries, external.positionFile, positionBytes, 6);
    statistics.assetByteLength += positionBytes.byteLength;
  }
  if (colorData) {
    const colorBytes = base64ToBytes(colorData);
    external.colorFile = `${cloudRoot}/colors.rgb8`;
    addEntry(entries, external.colorFile, colorBytes, 6);
    statistics.assetByteLength += colorBytes.byteLength;
  }
  external.preview = externalizeImage(
    preview,
    `${cloudRoot}/preview`,
    entries,
    statistics,
    'preview',
  );
  external.metadataFile = `${cloudRoot}/point-cloud.json`;
  addEntry(entries, external.metadataFile, jsonBytes({
    schemaVersion: 1,
    coordinateFrame: external.coordinateFrame,
    convention: external.convention,
    pointCount: external.pointCount,
    visiblePointCount: external.visiblePointCount,
    sourcePointCount: external.sourcePointCount,
    sampleMethod: external.sampleMethod,
    positionEncoding: external.positionEncoding,
    positionComponents: external.positionComponents,
    positionOffset: external.positionOffset,
    positionScale: external.positionScale,
    colorEncoding: external.colorEncoding,
    hasSourceRgb: external.hasSourceRgb,
    files: {
      positions: external.positionFile || null,
      colors: external.colorFile || null,
      preview: external.preview?.file || null,
    },
  }));
  statistics.pointCloudCount += 1;
  return external;
};

const externalizeCameraCapture = (
  capture,
  poseRoot,
  entries,
  statistics,
) => {
  if (!capture || typeof capture !== 'object') return null;
  const frames = Object.fromEntries(
    Object.entries(capture.frames || {}).flatMap(([side, frame]) => {
      if (!frame || typeof frame !== 'object') return [];
      const normalizedSide = sanitizeArchiveSegment(side, 'camera');
      const externalFrame = {
        ...frame,
        rgb: externalizeImage(
          frame.rgb,
          `${poseRoot}/rgb/${normalizedSide}`,
          entries,
          statistics,
          'rgb',
        ),
        pointCloud: externalizePointCloud(
          frame.pointCloud,
          `${poseRoot}/pointcloud/${normalizedSide}`,
          entries,
          statistics,
        ),
      };
      statistics.cameraFrameCount += 1;
      return [[side, externalFrame]];
    }),
  );
  return { ...capture, frames };
};

const externalizeTeachingTasks = (tasks, entries, statistics) => (
  (Array.isArray(tasks) ? tasks : []).map((task, taskIndex) => {
    const taskRoot = `teaching-data/${indexedFolder(
      taskIndex,
      task.name,
      'task',
    )}`;
    const parkingPoints = (task.parkingPoints || []).map((parkingPoint, parkingIndex) => {
      const parkingRoot = `${taskRoot}/${indexedFolder(
        parkingIndex,
        parkingPoint.name,
        'parking-point',
      )}`;
      const poses = (parkingPoint.poses || []).map((pose, poseIndex) => {
        const poseRoot = `${parkingRoot}/${indexedFolder(
          poseIndex,
          pose.name,
          'pose',
        )}`;
        const externalPose = {
          ...pose,
          cameraCapture: externalizeCameraCapture(
            pose.cameraCapture,
            poseRoot,
            entries,
            statistics,
          ),
        };
        addEntry(entries, `${poseRoot}/pose.json`, jsonBytes({
          schemaVersion: 1,
          recordType: 'teaching-pose',
          task: { id: task.id, name: task.name, sequence: task.sequence },
          parkingPoint: {
            id: parkingPoint.id,
            name: parkingPoint.name,
            sequence: parkingPoint.sequence,
          },
          pose: externalPose,
        }));
        statistics.poseCount += 1;
        return externalPose;
      });
      statistics.parkingPointCount += 1;
      return { ...parkingPoint, poses };
    });
    statistics.taskCount += 1;
    return { ...task, parkingPoints };
  })
);

const zipEntries = (entries) => new Promise((resolve, reject) => {
  zip(entries, { level: 6 }, (error, data) => {
    if (error) reject(error);
    else resolve(data);
  });
});

const unzipEntries = (bytes) => new Promise((resolve, reject) => {
  unzip(bytes, (error, data) => {
    if (error) reject(error);
    else resolve(data);
  });
});

export async function buildProjectArchive(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('工程配置为空，无法打包');
  const entries = {};
  const statistics = {
    taskCount: 0,
    parkingPointCount: 0,
    poseCount: 0,
    cameraFrameCount: 0,
    rgbFileCount: 0,
    pointCloudCount: 0,
    previewFileCount: 0,
    assetByteLength: 0,
  };
  const project = {
    ...payload,
    schemaVersion: '1.3',
    archive: {
      format: PROJECT_ARCHIVE_FORMAT,
      version: PROJECT_ARCHIVE_VERSION,
      manifestFile: PROJECT_ARCHIVE_MANIFEST,
      projectFile: PROJECT_ARCHIVE_CONFIG,
      mediaStorage: 'external-files',
    },
    virtualTeaching: {
      ...(payload.virtualTeaching || {}),
      tasks: externalizeTeachingTasks(
        payload.virtualTeaching?.tasks,
        entries,
        statistics,
      ),
    },
  };
  const projectFile = jsonBytes(project);
  addEntry(entries, PROJECT_ARCHIVE_CONFIG, projectFile);

  const manifest = {
    format: PROJECT_ARCHIVE_FORMAT,
    archiveVersion: PROJECT_ARCHIVE_VERSION,
    schemaVersion: project.schemaVersion,
    exportedAt: project.exportedAt || new Date().toISOString(),
    projectFile: PROJECT_ARCHIVE_CONFIG,
    layout: 'teaching-data/<task>/<parking-point>/<pose>/{pose.json,rgb,pointcloud}',
    statistics: {
      ...statistics,
      projectJsonByteLength: projectFile.byteLength,
      fileCount: Object.keys(entries).length + 2,
    },
  };
  addEntry(entries, PROJECT_ARCHIVE_MANIFEST, jsonBytes(manifest));
  addEntry(entries, 'README.txt', textBytes([
    'Atlas Route Studio 示教工程归档',
    '',
    `主配置：${PROJECT_ARCHIVE_CONFIG}`,
    '视觉目录：teaching-data/<任务>/<停车点>/<姿态>/',
    'RGB：rgb/<left|right>.<图片格式>',
    '点云：pointcloud/<left|right>/positions.u16le + colors.rgb8 + point-cloud.json',
    '',
    'positions.u16le 通过 point-cloud.json 中的 positionOffset / positionScale 还原坐标。',
    '请保留完整 ZIP，并在路径图谱工坊中直接选择 ZIP 重新加载。',
  ].join('\n')));

  const bytes = await zipEntries(entries);
  return {
    bytes,
    blob: new Blob([bytes], { type: 'application/zip' }),
    manifest,
    project,
    byteLength: bytes.byteLength,
  };
}

const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export async function downloadProjectArchive(payload, filename) {
  const archive = await buildProjectArchive(payload);
  triggerDownload(archive.blob, filename);
  return archive;
}

const readJsonEntry = (files, path, label) => {
  const bytes = files[path];
  if (!bytes) throw new Error(`${label}不存在：${path}`);
  try {
    return JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label}解析失败：${error.message}`);
  }
};

const requiredAsset = (files, path) => {
  const bytes = files[String(path || '')];
  if (!bytes) throw new Error(`ZIP 中缺少视觉资源：${path}`);
  return bytes;
};

const hydrateImage = (image, files) => {
  if (!image || typeof image !== 'object' || image.dataUrl || !image.file) {
    return image || null;
  }
  const bytes = requiredAsset(files, image.file);
  const { file, ...metadata } = image;
  const mimeType = String(metadata.mimeType || 'image/png');
  return {
    ...metadata,
    encoding: 'data-url',
    byteLength: bytes.byteLength,
    dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
  };
};

const base64Encoding = (value, fallback) => {
  const encoding = String(value || fallback);
  return /\/base64$/i.test(encoding) ? encoding : `${encoding}/base64`;
};

const hydratePointCloud = (pointCloud, files) => {
  if (!pointCloud || typeof pointCloud !== 'object') return null;
  const positionBytes = pointCloud.positionData
    ? null
    : pointCloud.positionFile ? requiredAsset(files, pointCloud.positionFile) : null;
  const colorBytes = pointCloud.colorData
    ? null
    : pointCloud.colorFile ? requiredAsset(files, pointCloud.colorFile) : null;
  const {
    positionFile,
    colorFile,
    metadataFile,
    ...metadata
  } = pointCloud;
  return {
    ...metadata,
    positionEncoding: base64Encoding(pointCloud.positionEncoding, 'uint16-le'),
    positionData: pointCloud.positionData || (positionBytes ? bytesToBase64(positionBytes) : ''),
    colorEncoding: base64Encoding(pointCloud.colorEncoding, 'rgb8'),
    colorData: pointCloud.colorData || (colorBytes ? bytesToBase64(colorBytes) : ''),
    preview: hydrateImage(pointCloud.preview, files),
  };
};

const hydrateProjectAssets = (project, files) => ({
  ...project,
  virtualTeaching: {
    ...(project.virtualTeaching || {}),
    tasks: (project.virtualTeaching?.tasks || []).map((task) => ({
      ...task,
      parkingPoints: (task.parkingPoints || []).map((parkingPoint) => ({
        ...parkingPoint,
        poses: (parkingPoint.poses || []).map((pose) => ({
          ...pose,
          cameraCapture: pose.cameraCapture
            ? {
                ...pose.cameraCapture,
                frames: Object.fromEntries(
                  Object.entries(pose.cameraCapture.frames || {}).map(([side, frame]) => [
                    side,
                    {
                      ...frame,
                      rgb: hydrateImage(frame.rgb, files),
                      pointCloud: hydratePointCloud(frame.pointCloud, files),
                    },
                  ]),
                ),
              }
            : null,
        })),
      })),
    })),
  },
});

export async function readProjectArchive(bytes) {
  const files = await unzipEntries(bytes);
  const manifest = readJsonEntry(
    files,
    PROJECT_ARCHIVE_MANIFEST,
    'ZIP 清单',
  );
  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new Error('ZIP 不是 Atlas Route Studio 示教工程包');
  }
  const projectPath = String(manifest.projectFile || PROJECT_ARCHIVE_CONFIG);
  const project = readJsonEntry(files, projectPath, '工程配置');
  return {
    payload: hydrateProjectAssets(project, files),
    source: 'zip',
    manifest,
    archiveFileCount: Object.keys(files).filter((path) => !path.endsWith('/')).length,
  };
}

const hasZipSignature = (bytes) => (
  bytes.length >= 4
  && bytes[0] === 0x50
  && bytes[1] === 0x4b
  && [0x03, 0x05, 0x07].includes(bytes[2])
  && [0x04, 0x06, 0x08].includes(bytes[3])
);

export async function readProjectFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (hasZipSignature(bytes) || String(file.name || '').toLowerCase().endsWith('.zip')) {
    return readProjectArchive(bytes);
  }
  try {
    return {
      payload: JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, '')),
      source: 'json',
      manifest: null,
      archiveFileCount: 0,
    };
  } catch (error) {
    throw new Error(`JSON 解析失败：${error.message}`);
  }
}
