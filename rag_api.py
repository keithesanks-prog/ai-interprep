"""
RAG API endpoint for retrieving relevant experiences.

Run this separately: python rag_api.py
Then it will be available at http://localhost:8000/retrieve
"""

import os
import json
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import chromadb
from chromadb.config import Settings
import google.generativeai as genai

app = FastAPI()

# Enable CORS for Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RetrieveRequest(BaseModel):
    query: str
    top_k: int = 5  # Number of experiences to retrieve


class Experience(BaseModel):
    id: int
    title: str
    company: str
    star_format: str


class RetrieveResponse(BaseModel):
    experiences: List[Experience]


def get_embedding(text: str, api_key: str) -> list:
    """Generate embedding using Gemini's embedding model."""
    genai.configure(api_key=api_key)
    try:
        result = genai.embed_content(
            model="models/embedding-001",
            content=text,
            task_type="retrieval_query" if "query" in text.lower() else "retrieval_document"
        )
        return result['embedding']
    except Exception as e:
        # Try alternative API format
        try:
            result = genai.embed_content(
                model="models/embedding-001",
                content=text
            )
            return result['embedding']
        except Exception as e2:
            raise Exception(f"Error generating embedding: {e2}")


@app.post("/retrieve", response_model=RetrieveResponse)
async def retrieve_experiences(request: RetrieveRequest):
    """Retrieve relevant experiences based on query."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not set")
    
    # Initialize ChromaDB
    db_path = "./chroma_db"
    if not os.path.exists(db_path):
        raise HTTPException(
            status_code=500,
            detail="ChromaDB not initialized. Please run ingest.py first."
        )
    
    try:
        client = chromadb.PersistentClient(path=db_path)
        collection = client.get_collection(name="experience_store")
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error accessing ChromaDB: {str(e)}"
        )
    
    # Generate embedding for query
    try:
        query_embedding = get_embedding(request.query, api_key)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error generating query embedding: {str(e)}"
        )
    
    # Query ChromaDB - retrieve more chunks to account for deduplication
    # We'll retrieve top_k * 3 chunks, then deduplicate by experience_id
    try:
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=min(request.top_k * 3, collection.count())
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error querying ChromaDB: {str(e)}"
        )
    
    # Format results and deduplicate by experience_id
    experiences = []
    seen_experience_ids = set()
    
    if results['ids'] and len(results['ids'][0]) > 0:
        for i, chunk_id in enumerate(results['ids'][0]):
            metadata = results['metadatas'][0][i]
            experience_id = metadata.get('experience_id', metadata.get('id'))
            
            # Skip if we've already seen this experience
            if experience_id in seen_experience_ids:
                continue
            
            # Only add if we haven't reached the requested number
            if len(experiences) >= request.top_k:
                break
            
            seen_experience_ids.add(experience_id)
            experiences.append(Experience(
                id=experience_id,
                title=metadata['title'],
                company=metadata['company'],
                star_format=metadata['star_format']
            ))
    
    return RetrieveResponse(experiences=experiences)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

