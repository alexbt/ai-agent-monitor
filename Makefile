.PHONY: install-deps install dev build start stop clean

# Port the dev and production servers bind. Override to stop a server that
# landed elsewhere because 3000 was taken: `make stop PORT=3001`.
PORT ?= 3000

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
install: node_modules

# The real install, run only when it would change something: node_modules is
# missing, or package.json / the lockfile is newer than the last install. `make`
# compares mtimes, and `touch` stamps the directory so a no-op stays a no-op.
#
# `build` depends on this so a fresh clone can go straight to `make start`.
# Without it the build runs with no dependencies and fails on "Module not found:
# can't resolve '@/lib/…'", which reads like broken source rather than the
# missing `npm install` it actually is.
#
# install-deps is order-only (`|`) because it is phony: as a normal prerequisite
# it would mark node_modules out of date on every single run.
node_modules: package.json package-lock.json | install-deps
	npm install
	@touch node_modules

# launch the app in development mode (hot reload) — http://localhost:3000
#
# Ctrl-C has to be made to work here. Two things get in the way, both measured:
# make's recipe shell swallows the interrupt so make, npm and the next-server
# worker all survive it; and `next` shuts down gracefully, draining open
# connections first — which never finishes, because a dashboard tab holds SSE
# streams open indefinitely. So the interrupt is caught and the server killed
# outright, with `stop` clearing the worker that killing npm would orphan.
dev: node_modules
	@npm run dev & pid=$$!; \
	trap 'kill -9 $$pid 2>/dev/null; $(MAKE) stop >/dev/null 2>&1; exit 130' INT TERM; \
	wait $$pid

# production build
build: node_modules
	npm run build

# launch the production build — http://localhost:3000
#
# Interrupt handling as in `dev` above — without it Ctrl-C leaves the server
# running and the port held.
#
# Builds first, deliberately: without this a fresh clone fails outright, since
# `next start` needs a build that has never happened. It also guards the case
# where .next holds development artifacts — dev and build share that directory,
# and a .next left in dev state has no BUILD_ID, which is the "Could not find a
# production build" error. Depending on `build` additionally means `make start`
# serves the code as it is now, not whenever you last remembered to build.
start: build
	@npm run start & pid=$$!; \
	trap 'kill -9 $$pid 2>/dev/null; $(MAKE) stop >/dev/null 2>&1; exit 130' INT TERM; \
	wait $$pid

# stop a server started by `make dev` or `make start`
#
# Two passes, because one isn't enough. The launcher's command line carries this
# checkout's path, so it can be matched exactly and a Next server belonging to
# some other project is never touched. Its worker is a separate process that
# renames itself to "next-server (vX.Y.Z)" with no path in its arguments, and it
# outlives the launcher often enough to matter — an orphaned worker still
# holding the port is exactly what makes the next `make start` look like it
# worked while serving stale code. That one has to be found by port.
stop:
	@stopped=0; \
	for pid in `pgrep -f "$(CURDIR)/node_modules/.bin/next" 2>/dev/null`; do \
		kill $$pid 2>/dev/null && stopped=1; \
	done; \
	for pid in `lsof -ti tcp:$(PORT) 2>/dev/null`; do \
		case "`ps -o command= -p $$pid 2>/dev/null`" in \
			*next*) kill $$pid 2>/dev/null && stopped=1 ;; \
			*) echo "left pid $$pid on port $(PORT) alone — not a Next server" ;; \
		esac; \
	done; \
	sleep 1; \
	for pid in `lsof -ti tcp:$(PORT) 2>/dev/null`; do \
		case "`ps -o command= -p $$pid 2>/dev/null`" in \
			*next*) kill -9 $$pid 2>/dev/null || true ;; \
		esac; \
	done; \
	if [ $$stopped -eq 1 ]; then \
		echo "stopped — port $(PORT) is free"; \
	else \
		echo "nothing to stop on port $(PORT)"; \
	fi

# remove build artifacts
clean:
	rm -rf .next tsconfig.tsbuildinfo
