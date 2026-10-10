.DEFAULT_GOAL := help
.PHONY: help install test test-python test-e2e lint format dev preview demo publish-demo docs docs-check build clean

help:  ## Show this help
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install:  ## Install Python and viewer dependencies, and Playwright's Chromium
	uv sync
	npm ci --prefix viewer --ignore-scripts --no-audit --no-fund
	cd viewer && npx playwright install chromium

test: test-python test-e2e  ## Run every test suite

test-python:  ## Pipeline tests (pytest)
	uv run pytest

test-e2e:  ## Browser tests against the demo mailbox (Playwright)
	npm --prefix viewer run test:e2e

lint:  ## ruff, Biome and the TypeScript compiler
	uv run ruff check .
	uv run ruff format --check .
	npm --prefix viewer run lint
	npm --prefix viewer run typecheck

format:  ## Format Python and TypeScript
	uv run ruff check --fix .
	uv run ruff format .
	npm --prefix viewer run format

dev:  ## Viewer with hot reload (http://localhost:5173), data from ./dist
	npm --prefix viewer run dev

demo:  ## Build the fictional demo mailbox and preview it
	uv run mbv build tests/fixtures/demo --slug demo --title "Parks Department (demo)"
	uv run mbv preview

publish-demo:  ## Rebuild the demo mailbox and publish it to the bucket in .env
	uv run mbv build tests/fixtures/demo --slug demo --title "Parks Department (demo)" --description "A fictional mailbox for trying Mailbox Viewer"
	uv run mbv publish demo --prune

preview:  ## Serve ./dist with the viewer
	uv run mbv preview

docs:  ## Regenerate docs/cli.md from the CLI's help
	uv run cog -r docs/cli.md

docs-check:  ## Fail if docs/cli.md is out of date
	uv run cog --check docs/cli.md

build:  ## Build the viewer, then the wheel and sdist into build/
	test -d viewer/node_modules || npm ci --prefix viewer --ignore-scripts --no-audit --no-fund
	npm --prefix viewer run build
	uv build -o build

clean:  ## Remove build output (not ./dist)
	rm -rf build viewer/dist viewer/.e2e-dist viewer/test-results viewer/playwright-report .pytest_cache .ruff_cache
