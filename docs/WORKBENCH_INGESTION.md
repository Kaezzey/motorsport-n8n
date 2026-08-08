# Motorsport Workbench manifest ingestion

The local input collection is copied to `data/incoming-manifests/`. That directory is ignored by Git, and the source Motorsport ML project is read-only to this prototype.

## Supported source contract

The adapter understands the existing Workbench output:

- immediate event subfolders such as `T07_QUE_250729/`;
- `manifest.json` with kind `motorsport-ml/run-manifest` and version `1.1`;
- included runs identified by `runs[].include`;
- portable run files under each event's `runs/` directory;
- `historical_data_csv_sha256` integrity checks;
- lap boundaries from `PDS Lap Number (-)`;
- buffered first/middle/last sequence metadata so the final lap is known without loading a complete run into memory;
- 100 Hz logger samples.

Absolute paths embedded in the manifest are not followed. The adapter uses only the basename to resolve `EVENT_FOLDER/runs/FILENAME`, then verifies the resolved file remains inside the copied event folder. This makes the copy portable and prevents a manifest from reading arbitrary files.

## Channel mapping

| Canonical channel | Workbench CSV column |
|---|---|
| `timestamp_ms` | `Time (ms)` |
| `speed_kph` | `ecu_speed (kph)` |
| `throttle_pct` | `ecu_aps (%)` |
| `brake_pressure_bar` | `log_pbrake_f (bar)` |
| `steering_deg` | `log_asteer (deg)` |
| `rpm` | `ecu_nmot (rpm)` |
| `gear` | `log_dash_gear (-)` |
| `longitudinal_g` | `log_acc_x (g)` |
| `lateral_g` | `log_acc_y (g)` |
| `yaw_rate_deg_s` | `*yaw (deg/s)` |
| four wheel speeds | four `ecu_speed_* (kph)` columns |
| `gps_course_deg` | `log_gps_course (deg)` |
| `gps_latitude_deg` | `log_gps_lat (deg)` |
| `gps_longitude_deg` | `log_gps_lon (deg)` |

No brake-pressure-to-percent conversion is performed. The canonical contract preserves measured front brake pressure in bar. GPS is required by this Workbench adapter because these exports contain it, while it remains optional for generic canonical JSON input.

## Safe first run

Run full-file validation without submitting laps:

```bash
npm run preflight -- data/incoming-manifests --output .local/preflight-report.json
```

This scans every included run, verifies its hash and schema, and records timestamp segments plus per-channel dropout intervals. A rejected file is never split into laps. A review-level file can be split, but every resulting lap is forced to human review.

Detailed reports are also stored by content hash under `.local/file-validation/`. Each lap carries that report hash and a compact preflight summary, so the evidence can be retrieved without duplicating a large report into every audit event.

Inspect and prepare two laps without contacting n8n:

```bash
npm run ingest -- data/incoming-manifests --dry-run --limit 2
```

Run the complete local sensor and lap-context evaluation without contacting n8n or appending audit events:

```bash
npm run evaluate -- data/incoming-manifests --output .local/milestone-4-evaluation.json
```

With the telemetry service and n8n running, submit one real lap:

```bash
npm run ingest -- data/incoming-manifests --limit 1
```

Submit the complete copied collection:

```bash
npm run ingest -- data/incoming-manifests --purpose driver_coaching
```

The adapter processes laps sequentially while retaining at most the active and pending lap. Each payload records its source lap number, run position, boundary source, and an independent sequence weak label. `include: false` runs are skipped, hash failures become `ingestion_error`, and manifest `review_required: true` or low match confidence forces human review even if the telemetry checks otherwise pass.
