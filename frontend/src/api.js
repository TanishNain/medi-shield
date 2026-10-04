const API_BASE =
  import.meta.env.VITE_API_URL ||
  "http://127.0.0.1:8000";

async function request(path, options = {}) {
  const response = await fetch(
    `${API_BASE}${path}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.detail ||
        data.message ||
        `Request failed: ${response.status}`
    );
  }

  return data;
}

export function checkHealth() {
  return request("/api/health");
}

export function chatWithMedly(payload) {
  return request("/api/medly/chat", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function analyzePrescription(
  imageData,
  extraContext = ""
) {
  return request("/api/medly/analyze", {
    method: "POST",
    body: JSON.stringify({
      image_data: imageData,
      extra_context: extraContext,
    }),
  });
}

export async function speakWithMedly(
  text,
  language = "en"
) {
  const response = await fetch(
    `${API_BASE}/api/medly/speak`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        language,
      }),
    }
  );

  if (!response.ok) {
    const data = await response
      .json()
      .catch(() => ({}));

    throw new Error(
      data.detail ||
        data.message ||
        "Voice generation failed."
    );
  }

  const blob = await response.blob();

  if (!blob.size) {
    throw new Error("Voice response was empty.");
  }

  return blob;
}

export { API_BASE };