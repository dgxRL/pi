# reduced/ — cross-package notes

Umbrella notes for the reduced copies under `reduced/<pkg>/`. Per-package docs
live inside each package folder (`reduced/<pkg>/doc/`, `reduced/<pkg>/README.md`);
this folder holds what spans packages.

## Contents

- (empty — add cross-package notes here)

## Conventions

- One folder per package: `reduced/<pkg>/`, self-contained (no workspace imports).
- Each copy: `src/` + `test/` + `README.md` (file map + simplifications) + `doc/` (deeper notes).
- Outside the root tsconfig and biome scope by default; typecheck via a throwaway
  tsconfig extending `tsconfig.base.json`, then delete it.
- Workflow: see the `reduced-learning-implementation` skill.
