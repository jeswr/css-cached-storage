# Slow commands

Commands whose runtime is worth knowing before you wait on them.

| Command | Time | Notes |
| --- | --- | --- |
| `npm install` | ~60–90 s (cold) | Pulls `@solid/community-server` as a devDep — a large tree. |
| `npm test` (`jest`) | ~12–15 s | Was ~80 s with ts-jest type-checking; cut by `isolatedModules: true` (transpile-only). `tsc --noEmit` is the type-check source of truth. |
| `npm run build` | ~15 s | `tsc` + `componentsjs-generator`. |
