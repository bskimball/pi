# Code-quality lens

Review implementation quality within the requested change and its real constraints. Flag complexity when it causes a concrete maintenance or correctness problem, and suggest the smallest useful simplification.

- Prefer removing unnecessary branches, duplicated rules, pass-through wrappers, and speculative options over rearranging them into more layers.
- Check that feature logic belongs to its owning module and reuses existing canonical helpers.
- Examine scattered special cases, unclear state models, unsafe casts, and silent fallbacks for actual broken contracts.
- Consider atomicity and concurrency where partial updates or serialization cause real problems.
- Extract a helper or module when it clarifies ownership or a coherent contract. File size alone is not a blocker, and fewer lines alone do not establish better code.

Keep useful boundary validation, required behavior, and repository conventions. Working direct code can be the right design. Treat broader restructuring as an optional tradeoff unless the current structure creates a demonstrated problem. Every actionable finding should name the code, consequence, and a practical improvement; a preference for a different design is insufficient.
