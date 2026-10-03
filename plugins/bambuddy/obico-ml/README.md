# Managed Obico ML for Bambuddy

This directory is the reproducible Windows-native Obico ML recipe used by the SOL Bambuddy plugin.

- No Docker.
- Runtime data is installed under `SOL_PLUGIN_DATA_DIR/obico-ml`.
- Upstream Obico source is pinned to the commit in `manifest.json`.
- The ONNX model is downloaded from Obico and verified by SHA-256.
- NVIDIA inference uses `onnxruntime-gpu` and pip-provided CUDA/cuDNN DLLs.
- The local service binds only to `127.0.0.1:3333`.
- Bambuddy points its native failure-detection integration at this service.

The plugin auto-starts an already-installed runtime. If the runtime is missing, the bootstrap can reconstruct it from these pinned inputs.
