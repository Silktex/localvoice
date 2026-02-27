.PHONY: stt-model stt-up stt-logs test

STT_MODEL ?= small
STT_MODEL_VOLUME ?= localvoice_whisper-models

stt-model:
	docker run --rm --entrypoint /bin/bash \
		-v $(STT_MODEL_VOLUME):/models \
		ghcr.io/ggml-org/whisper.cpp:main-vulkan \
		-lc "./models/download-ggml-model.sh $(STT_MODEL) /models"

stt-up:
	docker compose up -d --build whispercpp-backend whisper-stt

stt-logs:
	docker compose logs --tail=120 whispercpp-backend whisper-stt

test:
	./test-services.sh
