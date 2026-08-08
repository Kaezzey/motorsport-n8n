# Eight milestone gates

Each week is a pause point. Work should move forward only after the milestone evidence and policy choices are reviewed.

## Milestone 1 — Schema and labels (implemented)

Evidence in this repository:

- canonical JSON envelope and required channels;
- canonical units and initial physical ranges;
- `accept`, `review`, and `reject` labels;
- versioned hard-failure policy;
- clean and corrupted example laps;
- tests demonstrating all three decision paths;
- importable, gated n8n vertical slice.

Pause-gate questions:

- Do these channels match the Workbench Part 4 logger export?
- Are steering and yaw signs, gear conventions, and wheel-speed units correct?
- Which purposes need distinct suitability policies?
- Which failures must always reject, and which should request review?

## Milestone 2 — File and channel validation (implemented)

Evidence in this repository:

- streaming parser for the actual Workbench run CSV format;
- strict Workbench manifest v1.1 and canonical telemetry schema v1.0 contracts;
- explicit source-to-canonical channel and unit normalization metadata;
- full-file SHA-256, header-width, and numeric-channel validation before lap submission;
- timestamp duplicate, reset, gap, segment, and observed-rate evidence;
- per-channel missingness, invalid-value counts, and bounded dropout intervals;
- file-level `accept`, `review`, and `reject` gates propagated into lap provenance;
- synthetic tests for duplicates, resets, gaps, dropouts, hashes, and unsupported schema versions;
- sanitized real-data evidence covering 15 files and 980,765 rows in `evidence/milestone-2-summary.json`.

Pause-gate questions:

- Is a 50 ms contiguous dropout the correct threshold for mandatory review at 100 Hz?
- Should any timestamp gap reject immediately rather than request review?
- Are unassigned pre/post-lap rows intentionally excluded from lap analysis?
- Should optional GPS/TPMS channels join the required schema in Milestone 3?

## Milestone 3 — Sensor-quality checks (implemented)

Evidence in this repository:

- versioned N9115/Workbench logger profile with separately documented observed and physical ranges;
- duration-aware, activity-gated frozen-signal intervals;
- derivative rates scaled by elapsed milliseconds rather than sample count;
- bounded spike/recovery and dropout/recovery evidence;
- optional canonical GPS plus required Workbench GPS source mapping;
- GPS coordinate bounds, track envelope, held-position, jump-distance, and implied-speed checks;
- synthetic corruption tests for each diagnostic family;
- sanitized evaluation over 123 copied laps and 936,162 assigned samples in `evidence/milestone-3-summary.json`.

Pause-gate questions:

- Is `*yaw (deg/s)` the intended yaw channel, or is the constant value a conversion/mapping defect?
- Are the raw accelerometer oscillations expected logger behavior, or should the Workbench cleaner filter them before export?
- Which GPS jump threshold is appropriate for the logger update/interpolation strategy?
- Should sensor findings remain mandatory `review`, or should any become a hard rejection for model-training use?

## Milestone 4 — Lap-context analysis (implemented)

Evidence in this repository:

- source `PDS Lap Number` boundaries validated against a Queensland Raceway start/finish geofence and duration profile;
- last-lap pit termination handled explicitly rather than treated as a broken boundary;
- 123 run-sequence weak reference labels produced independently of classifier telemetry features;
- feature-based out-lap, push-lap, in-lap, and installation-lap scoring with evidence and score margins;
- empirical confidence bands and mandatory low-confidence or disagreement review routing;
- bounded taxonomy for vehicle stops, wheel-lock candidates, wheelspin candidates, and course excursions;
- 29 automated tests including classification, boundary, low-confidence, and abnormal-event cases;
- sanitized full-session evaluation in `evidence/milestone-4-summary.json` and per-lap labels in `evidence/milestone-4-labelled-laps.json`.

Pause-gate questions:

- Should the run-position weak labels be replaced or supplemented with engineer-reviewed labels?
- Is a 35 m start/finish geofence appropriate for this GPS logger and track layout?
- Should the six narrow-margin classifications remain review-only even though five agree with the weak labels?
- Are the two detected wheelspin candidates genuine events, logger artefacts, or expected race behaviour?

## Milestone 5 — Cross-channel diagnostics

Planned evidence:

- brake/deceleration lag and alignment model;
- driven/non-driven wheel and tyre-radius-aware speed comparison;
- normalized steering/yaw convention and lag handling;
- vehicle-specific RPM, speed, gear, and ratio consistency.

## Milestone 6 — Agent controller

Planned evidence:

- explicit diagnostic registry and action allow-list;
- policy for selecting follow-up investigations;
- structured explanation schema;
- adversarial tests showing the controller cannot bypass hard gates;
- optional LLM summarizer evaluated separately from decision logic.

## Milestone 7 — Dashboard and audit trail

Planned evidence:

- session and lap list with decision state;
- diagnostic plots tied to reason codes;
- identity-backed review and override controls;
- durable database and immutable-retention strategy;
- replay from trigger through final decision.

## Milestone 8 — Evaluation

Planned evidence:

- precision and recall for rejected laps;
- false-rejection rate by purpose and context;
- agreement and disagreement analysis with engineers;
- median review time and session turnaround saved;
- downstream-model ablation with and without the quality gate;
- repeated-input consistency and explanation-quality rubric.

## Prototype status versus milestone status

The prototype contains intentionally basic versions of checks from Milestone 5 so the complete control loop can be demonstrated. That milestone is not marked complete: it still needs real telemetry, domain labels, calibration, and acceptance evidence.
