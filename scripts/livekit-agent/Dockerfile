# Riley LiveKit agent — Dockerfile for Railway / any container host.
#
# Build:  docker build -t riley-livekit -f scripts/livekit-agent/Dockerfile .
# Run:    docker run --env-file .env riley-livekit
#
# On Railway: deploy this as a SECOND service in the dialog-receptionist project,
# pointed at the same repo with this Dockerfile path. It will auto-deploy on
# every git push and run as a persistent worker.

FROM python:3.12-slim

# Install build tools for any C-extensions Silero / soundfile may need
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ffmpeg \
        libsndfile1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY scripts/livekit-agent/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy the agent code + the prompt file (read at runtime)
COPY scripts/livekit-agent/agent.py /app/agent.py
COPY prompts/riley-livekit-prompt.md /app/prompts/riley-livekit-prompt.md

# Pre-download Silero VAD model to avoid cold-start cost on first call
RUN python -c "from livekit.plugins import silero; silero.VAD.load()" || true

# Tell agent.py where the prompt lives in this container layout
ENV PROMPT_PATH=/app/prompts/riley-livekit-prompt.md

# Run as a long-lived worker. LiveKit Agents framework handles connection
# management, room joining, and graceful shutdown.
CMD ["python", "agent.py", "start"]
