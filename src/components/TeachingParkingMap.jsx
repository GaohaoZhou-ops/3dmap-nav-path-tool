import { useMemo } from 'react';
import { MapPin, MousePointer2 } from 'lucide-react';
import Map2DView from './Map2DView.jsx';

const noop = () => {};

const finiteValue = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export default function TeachingParkingMap({
  mapData,
  heightRange,
  colorMode = 'height',
  parkingPoint,
}) {
  const bounds = mapData?.bounds;
  const pose = parkingPoint?.mapPose;
  const effectiveHeightRange = useMemo(() => {
    const lower = Number(heightRange?.[0]);
    const upper = Number(heightRange?.[1]);
    if (Number.isFinite(lower) && Number.isFinite(upper) && upper >= lower) {
      return [lower, upper];
    }
    return [finiteValue(bounds?.min?.z), finiteValue(bounds?.max?.z, 1)];
  }, [bounds?.max?.z, bounds?.min?.z, heightRange]);
  const parkingWaypoints = useMemo(() => {
    if (!parkingPoint || !pose) return [];
    return [{
      id: parkingPoint.id,
      name: parkingPoint.name,
      pose: {
        x: finiteValue(pose.position?.x),
        y: finiteValue(pose.position?.y),
        z: finiteValue(pose.position?.z),
        roll: finiteValue(pose.rpy?.roll),
        pitch: finiteValue(pose.rpy?.pitch),
        yaw: finiteValue(pose.rpy?.yaw),
      },
    }];
  }, [parkingPoint, pose]);
  const focusRequest = useMemo(() => (
    parkingPoint
      ? { type: 'waypoint', id: parkingPoint.id, revision: parkingPoint.id }
      : null
  ), [parkingPoint]);
  const hasMap = Boolean(bounds && mapData?.positions?.length);

  return (
    <section
      className="teaching-parking-map"
      aria-label="停车点二维地图位置"
      data-parking-point-id={parkingPoint?.id || ''}
      data-map-ready={hasMap ? 'true' : 'false'}
      data-slice-min={effectiveHeightRange[0]}
      data-slice-max={effectiveHeightRange[1]}
    >
      <header>
        <div><MapPin size={12} /><strong>停车点地图定位</strong></div>
        <span><MousePointer2 size={10} /> 滚轮缩放 · 左键拖拽</span>
      </header>
      <div className="teaching-parking-map__viewport">
        {hasMap ? (
          <Map2DView
            mapData={mapData}
            heightRange={effectiveHeightRange}
            waypoints={parkingWaypoints}
            edges={[]}
            mode="select"
            connectionSourceId={null}
            selectedWaypointId={parkingPoint?.id || null}
            selectedEdgeId={null}
            colorMode={colorMode}
            onAddWaypoint={noop}
            onSelectWaypoint={noop}
            onSelectEdge={noop}
            onConnectTarget={noop}
            onClearSelection={noop}
            onDeleteSelection={noop}
            onProjectionStats={noop}
            onViewChange={noop}
            focusRequest={focusRequest}
          />
        ) : (
          <div className="teaching-parking-map__empty">
            <MapPin size={19} />
            <span>地图数据尚未恢复，停车点坐标仍已安全归档。</span>
          </div>
        )}
      </div>
      <footer>
        <span>MAP · X {finiteValue(pose?.position?.x).toFixed(3)} / Y {finiteValue(pose?.position?.y).toFixed(3)}</span>
        <small>Z SLICE {effectiveHeightRange[0].toFixed(2)} — {effectiveHeightRange[1].toFixed(2)} m</small>
      </footer>
    </section>
  );
}
