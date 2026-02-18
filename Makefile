.PHONY: dev down ps logs phase3-check

dev:
	docker compose up --build

down:
	docker compose down -v

ps:
	docker compose ps

logs:
	docker compose logs -f

phase3-check:
	python3 scripts/e2e_pipeline_check.py
