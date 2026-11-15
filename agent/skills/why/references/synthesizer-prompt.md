# Synthesizer prompt template

Use for a substantial investigation or handoff; inline answers need no separate synthesis pass.

## Question and code anchor

{QUESTION}

{FILES_WITH_LINE_RANGES_AND_SYMBOLS}

## Evidence

{ALL_INVESTIGATOR_FINDINGS}

{MATERIAL_SOURCE_GAPS}

## Instructions

Answer the question from the evidence. Read all supplied findings, deduplicate overlaps, and preserve contradictions. Check citations when uncertain; all source access remains read-only.

Distinguish documented rationale, converging indirect evidence, inference, speculation, and unknowns. Cite direct claims and mark interpretation as interpretation. Code establishes mechanics, not author intent. Treat any hypothesis in the user's question as a candidate to check.

Lead with the best-supported answer. Add competing explanations, evidence gaps, and sources consulted when relevant. Use a coverage map only for a comprehensive investigation; omit empty sections and unrelated source categories. Do not manufacture uncertainty when evidence answers the question directly. The optional [epistemics guide](epistemics.md) supplies detailed calibration examples.
