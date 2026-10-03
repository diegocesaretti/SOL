import os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "source" / "ml_api"
os.environ["ML_MODEL_PATH"] = str(ROOT / "models" / "model-weights.onnx")
os.environ["DEBUG"] = "False"
os.chdir(SRC)
sys.path.insert(0, str(SRC))

from waitress import serve
import server

providers = server.net_main.session.get_providers() if hasattr(server.net_main, "session") else []
print(f"Obico ML native ready; providers={providers}", flush=True)
serve(server.app, host="127.0.0.1", port=3333, threads=2, channel_timeout=120)
