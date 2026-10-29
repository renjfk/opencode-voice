# Release process

Tag-push releases, same pattern as our other plugins (`opencode-prompt-left`,
`opencode-herdr`).

## How it works

1. Run one of the release scripts (they check, test, bump, tag, and push):
   ```bash
   bun run release:patch   # 0.7.0 -> 0.7.1
   bun run release:minor   # 0.7.0 -> 0.8.0
   bun run release:major   # 0.7.0 -> 1.0.0
   ```
   Each script runs `npm run check && npm test`, then `npm version <bump>`
   (creates the `vX.Y.Z` tag), then pushes `master` + the tag to `fork`.
2. Pushing a `v*.*.*` tag triggers `.github/workflows/npm-publish.yml`:
   verify tag == `package.json` version, run `prepack` + `npm pack --dry-run`,
   `npm publish --access public` (OIDC trusted publishing, no token), then
   create the GitHub Release.
3. The workflow can also be dispatched manually from the Actions tab.

## Prerequisites

- npm trusted publisher wired once on npmjs.com: package
  `@bojackduy/opencode-voice` ↔ repo `bojackduy/opencode-voice`, workflow
  `npm-publish.yml`.
- The tag must exactly match `package.json` `version`, and that version must
  not already exist on the registry, or the workflow fails fast.

## Troubleshooting

- `Git tag vX != package.json version`: you moved the tag by hand — delete it
  and re-run the release script.
- `already published`: bump again; npm versions are immutable.
- `401/404 on publish`: trusted publisher mapping missing or mismatched —
  re-check the npmjs.com setup.
