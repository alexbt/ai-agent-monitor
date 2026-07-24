.PHONY: install-deps install dev build start clean

# install node + npm if missing (next 15 / react 19 need node >= 18.18)
install-deps:
	@if command -v npm >/dev/null 2>&1; then \
		echo "npm $$(npm --version) already installed (node $$(node --version))"; \
	elif [ "$$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then \
		echo "npm not found — installing node via homebrew..."; \
		brew install node; \
	else \
		echo "npm not found. install node >= 18.18 from https://nodejs.org and re-run."; \
		exit 1; \
	fi

# install dependencies
install: install-deps
	npm install

# launch the app in development mode (hot reload) — http://localhost:3000
dev:
	npm run dev

# production build
build:
	npm run build

# launch the production build (run `make build` first)
start:
	npm run start

# remove build artifacts
clean:
	rm -rf .next tsconfig.tsbuildinfo
