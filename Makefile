.PHONY: dev down ps logs

dev:
	docker compose up --build

down:
	docker compose down -v

ps:
	docker compose ps

logs:
	docker compose logs -f
