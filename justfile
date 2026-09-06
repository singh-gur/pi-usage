# Show available recipes.
default:
    @just --list

# Install dependencies reproducibly (frozen lockfile).
install:
    pnpm install --frozen-lockfile

# Run tests (node --test, synthetic data only).
test:
    pnpm test

# Type-check without emitting files.
typecheck:
    pnpm run typecheck

# Verify package contents without publishing (pnpm pack --dry-run).
pack:
    pnpm run pack:check

# Bump version and create the matching git tag locally (no publish, no push).
# Usage: just bump patch|minor|major
@bump type:
    pnpm version {{type}}
    git push --follow-tags

# Publish the current version to npm and push commits/tags.
@publish:
    pnpm publish --access public

# Everything CI cares about: typecheck + tests + pack check.
check: typecheck test pack
