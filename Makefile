SHELL := /bin/sh
.DEFAULT_GOAL := help

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
NPM ?= npm
NODE ?= node

CANDIDATE_SOURCE ?= $(ROOT_DIR)
DATA_SOURCE ?=
AGENT_SOURCE ?=
BASELINE_COMMIT ?=
TX ?=
ACTIVATION_ID ?= $(TX)
DATA_LOSS_AUTHORIZATION ?=
SUPERSEDE_PENDING ?=
QA_NAME ?= weekly-recipe-planner-qa
QA_PORTLESS_PORT ?= 1355
QA_DATA_SOURCE ?= $(ROOT_DIR)/.planner-data/planner.sqlite
QA_STATE_DIR ?= $(ROOT_DIR)/.planner-qa

.PHONY: \
	help \
	deploy-setup \
	deploy-stage \
	deploy-activate \
	deploy-activate-uninitialized \
	deploy-status \
	deploy-recover \
	deploy-rollback \
	deploy-service-install \
	deploy-service-restart \
	deploy-service-start \
	deploy-service-status \
	deploy-service-stop \
	deploy-service-uninstall \
	qa-local \
	qa-deploy \
	qa-status \
	qa-stop \
	deploy-start

help:
	@printf '%s\n' \
		'Deployment targets:' \
		'  make deploy-setup DATA_SOURCE=/absolute/planner.sqlite [AGENT_SOURCE=/absolute/agent]' \
		'      Stage the current source; alias for deploy-stage.' \
		'  make deploy-activate ACTIVATION_ID=<id> [SUPERSEDE_PENDING=<stale-id>]' \
		'      Reuse dedicated credentials, prove authenticated readback, and run installed QA.' \
		'  make deploy-activate-uninitialized ACTIVATION_ID=<id>' \
		'      Activate an intentionally empty household authority.' \
		'  make deploy-status [ACTIVATION_ID=<id>]' \
		'      Read all release state or one transaction.' \
		'  make deploy-recover ACTIVATION_ID=<id>' \
		'      Recover an interrupted transaction.' \
		'  make deploy-rollback ACTIVATION_ID=<id> [DATA_LOSS_AUTHORIZATION=<proof>]' \
		'      Roll back one committed release.' \
		'  make qa-local' \
		'      Run browser QA against this mutable checkout; produces no release evidence.' \
		'  make qa-deploy [QA_NAME=weekly-recipe-planner-qa] [QA_PORTLESS_PORT=1355] [QA_DATA_SOURCE=/absolute/planner.sqlite]' \
		'      Build, then replace the managed snapshot-backed QA deployment at http://<QA_NAME>.localhost:<QA_PORTLESS_PORT>.' \
		'  make qa-status | qa-stop' \
		'      Check or stop the managed QA deployment and remove its private snapshot.' \
		'  make deploy-start' \
		'      Start the selected installed app in the foreground.' \
		'  make deploy-service-install' \
		'      Install, enable, start, and health-check the user LaunchAgent.' \
		'  make deploy-service-restart' \
		'      Rebind the LaunchAgent to the selected release and restart it.' \
		'  make deploy-service-start | deploy-service-stop | deploy-service-status' \
		'      Control or inspect the installed user LaunchAgent.' \
		'  make deploy-service-uninstall' \
		'      Stop the service and remove only its managed plist.' \
		'' \
		'Variables:' \
		'  DATA_SOURCE           Required absolute SQLite path for staging.' \
		'  AGENT_SOURCE          Required first-install authenticated agent home; omit for updates.' \
		'  CANDIDATE_SOURCE      Absolute candidate path; defaults to this repo.' \
		'  BASELINE_COMMIT       Optional override; defaults to the release manifest.' \
		'  ACTIVATION_ID or TX   Transaction ID returned by deploy-setup.' \
		'  SUPERSEDE_PENDING     Exact eligible staged pending transaction to retire.'

deploy-setup: deploy-stage

deploy-stage:
	@if [ -z "$(strip $(DATA_SOURCE))" ]; then \
		printf '%s\n' 'error: DATA_SOURCE is required and must be an absolute SQLite path.' >&2; \
		exit 2; \
	fi
	@case "$(DATA_SOURCE)" in \
		/*) ;; \
		*) printf '%s\n' 'error: DATA_SOURCE must be an absolute path.' >&2; exit 2 ;; \
	esac
	@case "$(CANDIDATE_SOURCE)" in \
		/*) ;; \
		*) printf '%s\n' 'error: CANDIDATE_SOURCE must be an absolute path.' >&2; exit 2 ;; \
	esac
	@if [ -n "$(strip $(AGENT_SOURCE))" ]; then \
		case "$(AGENT_SOURCE)" in \
			/*) ;; \
			*) printf '%s\n' 'error: AGENT_SOURCE must be an absolute path.' >&2; exit 2 ;; \
		esac; \
	fi
	@baseline_commit="$(strip $(BASELINE_COMMIT))"; \
	if [ -z "$$baseline_commit" ]; then \
		baseline_commit="$$(cd "$(ROOT_DIR)" && $(NODE) -e 'const { readFileSync } = require("node:fs"); const value = JSON.parse(readFileSync("deployment/release/first-install-baseline.json", "utf8")); process.stdout.write(value.baselineCommit);')"; \
	fi; \
	set -- stage \
		--candidate-source "$(CANDIDATE_SOURCE)" \
		--baseline-commit "$$baseline_commit" \
		--data-source "$(DATA_SOURCE)"; \
	if [ -n "$(strip $(AGENT_SOURCE))" ]; then \
		set -- "$$@" --agent-source "$(AGENT_SOURCE)"; \
	fi; \
	cd "$(ROOT_DIR)" && $(NPM) run planner:release -- "$$@"

deploy-activate:
	@if [ -z "$(strip $(ACTIVATION_ID))" ]; then \
		printf '%s\n' 'error: ACTIVATION_ID (or TX) is required.' >&2; \
		exit 2; \
	fi
	@set -- activate \
		--transaction "$(ACTIVATION_ID)" \
		--authorized; \
	if [ -n "$(strip $(SUPERSEDE_PENDING))" ]; then \
		set -- "$$@" --supersede-pending "$(SUPERSEDE_PENDING)"; \
	fi; \
	cd "$(ROOT_DIR)" && $(NPM) run planner:release -- "$$@"

deploy-activate-uninitialized:
	@if [ -z "$(strip $(ACTIVATION_ID))" ]; then \
		printf '%s\n' 'error: ACTIVATION_ID (or TX) is required.' >&2; \
		exit 2; \
	fi
	@cd "$(ROOT_DIR)" && $(NPM) run planner:release -- activate \
		--transaction "$(ACTIVATION_ID)" \
		--authorized \
		--confirm-uninitialized-authority

deploy-status:
	@if [ -n "$(strip $(ACTIVATION_ID))" ]; then \
		cd "$(ROOT_DIR)" && $(NPM) run planner:release -- status \
			--transaction "$(ACTIVATION_ID)"; \
	else \
		cd "$(ROOT_DIR)" && $(NPM) run planner:release -- status; \
	fi

deploy-recover:
	@if [ -z "$(strip $(ACTIVATION_ID))" ]; then \
		printf '%s\n' 'error: ACTIVATION_ID (or TX) is required.' >&2; \
		exit 2; \
	fi
	@cd "$(ROOT_DIR)" && $(NPM) run planner:release -- recover \
		--transaction "$(ACTIVATION_ID)"

deploy-rollback:
	@if [ -z "$(strip $(ACTIVATION_ID))" ]; then \
		printf '%s\n' 'error: ACTIVATION_ID (or TX) is required.' >&2; \
		exit 2; \
	fi
	@if [ -n "$(strip $(DATA_LOSS_AUTHORIZATION))" ]; then \
		cd "$(ROOT_DIR)" && $(NPM) run planner:release -- rollback \
			--transaction "$(ACTIVATION_ID)" \
			--authorize-data-loss "$(DATA_LOSS_AUTHORIZATION)"; \
	else \
		cd "$(ROOT_DIR)" && $(NPM) run planner:release -- rollback \
			--transaction "$(ACTIVATION_ID)"; \
	fi

qa-local:
	@cd "$(ROOT_DIR)" && $(NPM) run test:e2e:installed

qa-deploy:
	@case "$(QA_NAME)" in \
		*[!a-z0-9-]*|'') printf '%s\n' 'error: QA_NAME must contain only lowercase letters, digits, and hyphens.' >&2; exit 2 ;; \
		*) ;; \
	esac
	@case "$(QA_PORTLESS_PORT)" in \
		*[!0-9]*|'') printf '%s\n' 'error: QA_PORTLESS_PORT must be an integer.' >&2; exit 2 ;; \
		*) ;; \
	esac
	@case "$(QA_DATA_SOURCE)" in \
		/*) ;; \
		*) printf '%s\n' 'error: QA_DATA_SOURCE must be an absolute SQLite path.' >&2; exit 2 ;; \
	esac
	@case "$(QA_STATE_DIR)" in \
		/*) ;; \
		*) printf '%s\n' 'error: QA_STATE_DIR must be an absolute path.' >&2; exit 2 ;; \
	esac
	@cd "$(ROOT_DIR)" && $(NPM) run build
	@cd "$(ROOT_DIR)" && \
		QA_DATA_SOURCE="$(QA_DATA_SOURCE)" \
		QA_NAME="$(QA_NAME)" \
		QA_NPM_COMMAND="$(NPM)" \
		QA_PORTLESS_PORT="$(QA_PORTLESS_PORT)" \
		QA_STATE_DIR="$(QA_STATE_DIR)" \
		$(NODE) --disable-warning=ExperimentalWarning scripts/qa-deployment-manager.mjs start

qa-status:
	@cd "$(ROOT_DIR)" && \
		QA_NAME="$(QA_NAME)" \
		QA_PORTLESS_PORT="$(QA_PORTLESS_PORT)" \
		QA_STATE_DIR="$(QA_STATE_DIR)" \
		$(NODE) --disable-warning=ExperimentalWarning scripts/qa-deployment-manager.mjs status

qa-stop:
	@cd "$(ROOT_DIR)" && \
		QA_NAME="$(QA_NAME)" \
		QA_PORTLESS_PORT="$(QA_PORTLESS_PORT)" \
		QA_STATE_DIR="$(QA_STATE_DIR)" \
		$(NODE) --disable-warning=ExperimentalWarning scripts/qa-deployment-manager.mjs stop

deploy-start:
	@cd "$(ROOT_DIR)" && $(NPM) run start:installed

deploy-service-install:
	@cd "$(ROOT_DIR)" && $(NODE) --disable-warning=ExperimentalWarning scripts/planner-service.mjs install

deploy-service-restart:
	@cd "$(ROOT_DIR)" && $(NODE) --disable-warning=ExperimentalWarning scripts/planner-service.mjs restart

deploy-service-start:
	@cd "$(ROOT_DIR)" && $(NODE) --disable-warning=ExperimentalWarning scripts/planner-service.mjs start

deploy-service-status:
	@cd "$(ROOT_DIR)" && $(NODE) --disable-warning=ExperimentalWarning scripts/planner-service.mjs status

deploy-service-stop:
	@cd "$(ROOT_DIR)" && $(NODE) --disable-warning=ExperimentalWarning scripts/planner-service.mjs stop

deploy-service-uninstall:
	@cd "$(ROOT_DIR)" && $(NODE) --disable-warning=ExperimentalWarning scripts/planner-service.mjs uninstall
