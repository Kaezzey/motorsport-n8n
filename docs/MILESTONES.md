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

## Milestone 2 — File and channel validation

Planned evidence:

- parsers for the actual CSV, MAT, MDF, or vendor export format;
- schema-version migration and unit normalization;
- timestamp reset and duplicate-segment handling;
- sampling-rate tests using full-session fixtures;
- per-channel missingness and dropout intervals.

## Milestone 3 — Sensor-quality checks

Planned evidence:

- duration-aware frozen-signal detection;
- vehicle/logger-specific ranges;
- derivatives scaled by elapsed time;
- spike, dropout, and recovery detection;
- GPS bounds, jumps, and fix-quality validation.

## Milestone 4 — Lap-context analysis

Planned evidence:

- track-aware lap segmentation;
- independently labelled out-lap, in-lap, and push-lap set;
- abnormal-event taxonomy;
- confidence calibration and low-confidence review routing.

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

The prototype contains intentionally basic versions of checks from Milestones 2–5 so the complete control loop can be demonstrated. Those milestones are not marked complete: each still needs real telemetry, domain labels, calibration, and acceptance evidence.
