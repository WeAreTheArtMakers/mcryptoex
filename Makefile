.PHONY: dev down ps logs phase3-check phase5-check api-test security-check

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

api-test:
	PYTHONPATH=. python3 -m unittest discover -s apps/api/tests -p 'test_*.py'

security-check:
	./scripts/security_check.sh

phase5-check:
	npm run test:contracts
	npm run web:build
	python3 scripts/e2e_pipeline_check.py
	./scripts/security_check.sh
