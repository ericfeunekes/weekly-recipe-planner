SHELL := /bin/sh
.DEFAULT_GOAL := help

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
NPM ?= npm
NODE ?= node
QA_NAME ?= weekly-recipe-planner-qa
QA_PORTLESS_PORT ?= 1355
QA_DATA_SOURCE ?= $(ROOT_DIR)/.planner-data/planner.sqlite
QA_STATE_DIR ?= $(ROOT_DIR)/.planner-qa
DEV_NAME ?= weekly-recipe-planner-dev
DEV_PORTLESS_PORT ?= 1355
DEV_DATA_SOURCE ?= $(ROOT_DIR)/.planner-data/planner.sqlite
DEV_STATE_DIR ?= $(ROOT_DIR)/.planner-dev

.PHONY: help promote recover qa-local qa-deploy qa-status qa-stop dev-start dev-status dev-stop

help:
	@printf '%s\n' \
		'  make promote' \
		'      The only production release command: deploy committed main from a disposable worktree.' \
		'  make recover' \
		'      Recovery-only: keep a ready selected app or restore the immediately previous app.' \
		'  make qa-deploy | qa-status | qa-stop' \
		'      Manage the isolated snapshot-backed QA app.' \
		'  make dev-start | dev-status | dev-stop' \
		'      Manage this worktree development app.'

promote:
	@$(NODE) scripts/promote.mjs

recover:
	@$(NODE) scripts/promote.mjs --recover

qa-local:
	@cd "$(ROOT_DIR)" && $(NPM) run test:e2e

qa-deploy:
	@cd "$(ROOT_DIR)" && $(NPM) run build
	@cd "$(ROOT_DIR)" && QA_DATA_SOURCE="$(QA_DATA_SOURCE)" QA_NAME="$(QA_NAME)" QA_NPM_COMMAND="$(NPM)" QA_PORTLESS_PORT="$(QA_PORTLESS_PORT)" QA_STATE_DIR="$(QA_STATE_DIR)" $(NODE) --disable-warning=ExperimentalWarning scripts/qa-deployment-manager.mjs start

qa-status:
	@cd "$(ROOT_DIR)" && QA_NAME="$(QA_NAME)" QA_PORTLESS_PORT="$(QA_PORTLESS_PORT)" QA_STATE_DIR="$(QA_STATE_DIR)" $(NODE) --disable-warning=ExperimentalWarning scripts/qa-deployment-manager.mjs status

qa-stop:
	@cd "$(ROOT_DIR)" && QA_NAME="$(QA_NAME)" QA_PORTLESS_PORT="$(QA_PORTLESS_PORT)" QA_STATE_DIR="$(QA_STATE_DIR)" $(NODE) --disable-warning=ExperimentalWarning scripts/qa-deployment-manager.mjs stop

dev-start:
	@$(MAKE) qa-deploy QA_NAME="$(DEV_NAME)" QA_PORTLESS_PORT="$(DEV_PORTLESS_PORT)" QA_DATA_SOURCE="$(DEV_DATA_SOURCE)" QA_STATE_DIR="$(DEV_STATE_DIR)"

dev-status:
	@$(MAKE) qa-status QA_NAME="$(DEV_NAME)" QA_PORTLESS_PORT="$(DEV_PORTLESS_PORT)" QA_STATE_DIR="$(DEV_STATE_DIR)"

dev-stop:
	@$(MAKE) qa-stop QA_NAME="$(DEV_NAME)" QA_PORTLESS_PORT="$(DEV_PORTLESS_PORT)" QA_STATE_DIR="$(DEV_STATE_DIR)"
