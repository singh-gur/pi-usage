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

# Everything CI cares about: typecheck + tests + pack check.
check: typecheck test pack
