FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY src ./src

RUN adduser --disabled-password --gecos "" --uid 1000 app \
 && chown -R app:app /app
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request,sys;\
sys.exit(0 if urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','3000')+'/health',timeout=3).status==200 else 1)"

CMD ["sh", "-c", "uvicorn src.server:app --host 0.0.0.0 --port ${PORT:-3000}"]
