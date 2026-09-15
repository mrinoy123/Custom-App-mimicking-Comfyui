/**
 * Node Definitions and Registry for Visual Canvas Editor
 */

const NODE_DEFINITIONS = {
  UNETLoaderGGUF: {
    title: "UNET Loader (GGUF Q4)",
    color: "#4338ca",
    inputs: {},
    outputs: { MODEL: "MODEL" },
    fields: {
      unet_name: { type: "text", default: "flux1-dev-Q4_0.gguf", label: "Model File" }
    }
  },
  CLIPTextEncode: {
    title: "CLIP Text Encode (Prompt)",
    color: "#b45309",
    inputs: { clip: "CLIP" },
    outputs: { CONDITIONING: "CONDITIONING" },
    fields: {
      text: { type: "textarea", default: "A futuristic city at sunset, 8k photorealistic", label: "Prompt" }
    }
  },
  KSampler: {
    title: "KSampler (FlowMatch Euler)",
    color: "#047857",
    inputs: {
      model: "MODEL",
      positive: "CONDITIONING",
      negative: "CONDITIONING",
      latent_image: "LATENT"
    },
    outputs: { LATENT: "LATENT" },
    fields: {
      steps: { type: "number", default: 20, label: "Steps" },
      cfg: { type: "number", default: 3.5, label: "CFG" },
      seed: { type: "number", default: 42, label: "Seed" }
    }
  },
  VAEDecode: {
    title: "VAE Decode",
    color: "#be185d",
    inputs: {
      samples: "LATENT",
      vae: "VAE"
    },
    outputs: { IMAGE: "IMAGE" },
    fields: {}
  },
  SaveImage: {
    title: "Save Image (PNG)",
    color: "#0369a1",
    inputs: { images: "IMAGE" },
    outputs: {},
    fields: {
      filename_prefix: { type: "text", default: "flux_image", label: "Prefix" }
    }
  },
  SaveVideo: {
    title: "Save Video (MP4)",
    color: "#6d28d9",
    inputs: { images: "IMAGE" },
    outputs: {},
    fields: {
      filename_prefix: { type: "text", default: "ltx_video", label: "Prefix" },
      fps: { type: "number", default: 24, label: "FPS" }
    }
  }
};

window.NODE_DEFINITIONS = NODE_DEFINITIONS;
