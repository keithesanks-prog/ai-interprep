import os
import json
import chromadb
from chromadb.utils import embedding_functions

EMBEDDING_MODEL = os.getenv("GEMINI_EMBED_MODEL", "models/embedding-001")
COLLECTION_NAME = "general_kb"
KB_PATH = os.getenv("GENERAL_KB_PATH", "general_kb.json")

if not os.path.exists(KB_PATH):
    raise FileNotFoundError(f"Knowledge base file '{KB_PATH}' not found.")

with open(KB_PATH, "r", encoding="utf-8") as f:
    entries = json.load(f)

if not entries:
    raise ValueError("Knowledge base file is empty.")

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise EnvironmentError("GEMINI_API_KEY is not set. Please export your Gemini API key before running ingestion.")

client = chromadb.PersistentClient(path="./chroma_db")

# Re-create collection for a clean ingest
for collection in client.list_collections():
    if collection.name == COLLECTION_NAME:
        client.delete_collection(name=COLLECTION_NAME)
        break

collection = client.create_collection(
    name=COLLECTION_NAME,
    embedding_function=embedding_functions.GoogleGenerativeAiEmbeddingFunction(
        api_key=api_key,
        model_name=EMBEDDING_MODEL,
    ),
)

collection.add(
    ids=[entry["id"] for entry in entries],
    documents=[entry["content"] for entry in entries],
    metadatas=[{"title": entry.get("title", ""), "kb": "general"} for entry in entries],
)

print(f"Ingested {len(entries)} general knowledge entries into collection '{COLLECTION_NAME}'.")
