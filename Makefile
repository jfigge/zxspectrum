NPM ?= npm

.DEFAULT_GOAL := help
.PHONY: help install roms dev build start typecheck test test-zex test-all check dist clean distclean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

node_modules: package.json package-lock.json
	$(NPM) install
	@touch node_modules

install: ## Install dependencies (also downloads the ROMs)
	$(NPM) install
	@touch node_modules

roms: node_modules ## Download the Sinclair ROMs again
	$(NPM) run fetch-roms

dev: node_modules ## Launch with hot reload
	$(NPM) run dev

build: node_modules ## Make a production build in out/
	$(NPM) run build

start: node_modules ## Preview the production build
	$(NPM) start

typecheck: node_modules ## Run TypeScript checks
	$(NPM) run typecheck

test: node_modules ## Unit tests and the FUSE Z80 suite
	$(NPM) test

test-zex: node_modules ## ZEXDOC/ZEXALL exercisers (~3 minutes)
	$(NPM) run test:zex

test-all: test test-zex ## All tests, including ZEX

check: typecheck test ## Typecheck and run the fast tests

dist: node_modules ## Package a macOS .dmg in dist/
	$(NPM) run dist

clean: ## Remove build output (out/, dist/)
	rm -rf out dist

distclean: clean ## Also remove node_modules (keeps ROMs and games/)
	rm -rf node_modules
