#!/usr/bin/env bash
set -euo pipefail

JOB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${ATLAS_MERGE_VENV:-${JOB_ROOT}/.atlas-merge-venv}"

printf '\n[SETUP 1/3] Preparing isolated Python environment: %s\n' "${VENV_DIR}"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

printf '[SETUP 2/3] Checking compute dependencies\n'
"${VENV_DIR}/bin/python" -m pip install --disable-pip-version-check -r "${JOB_ROOT}/requirements.txt"
printf '[SETUP 3/3] Starting Atlas parking merge planner\n\n'
"${VENV_DIR}/bin/python" "${JOB_ROOT}/scripts/compute_parking_merge.py" \
  --job-root "${JOB_ROOT}" \
  --output-dir "${JOB_ROOT}/output" \
  "$@"
