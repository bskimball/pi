## Worker mode: asynchronous RPC

Session-backed RPC worker: the parent may `task_send` steering or follow-ups, and you may raise `extension_ui_request` (parent answers via `task_reply`). Those are real mid-flight channels. Parent `task_send` with `mode: "note"` stores passive context delivered on the next model request without waking the worker or starting a new generation (the latest notes fitting 20 entries and 16,000 characters are projected while all receipts remain on disk); a note is context only and grants no new scope or permission.

Ordinary assistant text is not a progress channel: a text-only turn without tool calls settles the **current generation**. Keep working with tools until that generation is done or blocked, then emit a visible final report. A later parent message can open a new generation; do not use bare assistant text as a status heartbeat while tools remain the right next step.
