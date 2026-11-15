Applies when: Repetitive edits, migrations, or analyses would benefit from a reusable script or deterministic check.

# Build the Lever

Use automation when it reduces total work or makes a risky transformation easier to verify. Direct edits are appropriate for bounded one-off changes, including non-trivial ones.

For repeated transformations, inspect a representative unit, automate the stable recipe, and compare the result with the intended change. Make scripts safe to rerun and keep their write scope explicit. Prefer existing tools to a new framework or manual fanout.

Keep a script in the repository when future maintainers will use it; otherwise use a temporary script. Applying this principle does not require a new file, committed helper, skill, or delegated team.
