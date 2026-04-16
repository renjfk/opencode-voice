# Manual release process

This document describes the step-by-step manual release process for opencode-voice using AI assistance to analyze commits, generate release notes, and trigger the GitHub Actions workflow via opencode (with `gh` CLI integration).

## Overview

1. **AI-driven commit analysis** - analyze commit history since last release
2. **AI-generated release notes** following strict formatting conventions
3. **Preview and review** - release notes shown before any actions taken
4. **Human review and approval** for quality control
5. **Workflow dispatch** - trigger GitHub Actions via `gh` CLI
6. **Automated publish** - existing workflow handles npm publish and GitHub Release creation

## Prerequisites

- [opencode](https://opencode.ai/) installed
- [GitHub CLI (`gh`)](https://cli.github.com) installed and authenticated (`gh auth login`)
- Understanding of conventional commit patterns
- Trusted publishing configured on npmjs.com (no token required)

## AI-assisted release process

Use this prompt in opencode to handle the entire release process:

### Master release prompt

```
I need to create a new release for opencode-voice. Please:

STEP 1: ANALYZE COMMITS
- Use `gh` CLI or available tools to get the latest release tag
- Fetch all commits between that tag and current HEAD
- Analyze each commit for user-facing changes

STEP 2: GENERATE RELEASE NOTES
Create structured release notes with this EXACT format:

### Breaking Changes
[Only if breaking changes exist - triggers major version]
- Description focusing on user impact (abc1234)

### New Features
- Feature description emphasizing user benefit (abc1234)

### Improvements
- Improvement description with user impact (abc1234)

### Bug Fixes
- Fix description focusing on resolved user issue (abc1234)

REQUIREMENTS:
- Focus ONLY on user-facing changes and impact
- EXCLUDE: docs, build, ci, chore, refactor, test commits
- Use active voice, present tense
- Include commit short hashes (GitHub renders as links)
- Semver version logic (major.minor.patch):
  - PATCH: bug fixes, docs, build/CI changes only
  - MINOR: new features, improvements, backwards compatible
  - MAJOR: breaking changes
- Show this preview BEFORE any actions

STEP 3: SHOW PREVIEW
Display the generated release notes and ask for approval before proceeding.

STEP 4: TRIGGER WORKFLOW (after approval)
Use `gh workflow run` to trigger the "Publish Release" workflow:

gh workflow run release.yml \
  -f release_tag="v[VERSION]" \
  -f release_notes="[generated content]" \
  -f draft=true \
  -f prerelease=false

Please start with Step 1 - analyze the commits and show me the preview.
```

## How it works

opencode will:

1. **Analyze commits** since last release via `gh` CLI
2. **Generate release notes** with proper formatting and categorization
3. **Show preview** and ask for approval
4. **Trigger GitHub Actions workflow** with the release notes
5. **Workflow** sets the package version, publishes to npm with provenance, and creates a GitHub Release

## Features

- **Automatic filtering** of technical commits (docs, tests, CI, etc.)
- **User-focused** release notes with clear impact descriptions
- **Semver versioning** - patch for fixes, minor for features, major for breaking changes
- **Preview before action** - human approval required
- **npm provenance** - published packages include provenance attestation

## Troubleshooting

- **gh CLI issues**: Run `gh auth status` to verify authentication
- **Workflow dispatch failed**: Check repository permissions for workflow dispatch
- **npm publish failed**: Verify trusted publishing is configured on npmjs.com
- **Invalid release notes**: Review format requirements and regenerate
