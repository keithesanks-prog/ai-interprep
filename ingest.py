#!/usr/bin/env python3
"""
Ingest experiences into ChromaDB vector database using Gemini embeddings.

This script:
1. Loads experiences from experiences.json
2. Chunks the description field using LangChain text splitter
3. Generates embeddings using Google's Gemini embedding model
4. Stores them in ChromaDB for efficient retrieval
"""

import json
import os
import sys
from pathlib import Path

try:
    import google.generativeai as genai
    import chromadb
    from chromadb.config import Settings
    from langchain.text_splitter import RecursiveCharacterTextSplitter
except ImportError as e:
    print(f"❌ Missing required package: {e}")
    print("Please install dependencies: pip install -r requirements.txt")
    sys.exit(1)


def load_experiences(json_path: str = "experiences.json"):
    """Load experiences from JSON file."""
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            experiences = json.load(f)
        print(f"✅ Loaded {len(experiences)} experiences from {json_path}")
        return experiences
    except FileNotFoundError:
        print(f"❌ Error: {json_path} not found")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"❌ Error parsing JSON: {e}")
        sys.exit(1)


def chunk_description(description: str, chunk_size: int = 300, chunk_overlap: int = 50):
    """
    Chunk the description field into smaller pieces.
    
    Args:
        description: The description text to chunk
        chunk_size: Maximum size of each chunk (default: 300)
        chunk_overlap: Overlap between chunks (default: 50)
    
    Returns:
        List of text chunks
    """
    if not description or len(description.strip()) == 0:
        return [description] if description else [""]
    
    # Initialize text splitter
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=len,
        separators=["\n\n", "\n", ". ", " ", ""]
    )
    
    # Split the description
    chunks = text_splitter.split_text(description)
    return chunks


def get_embedding(text: str, api_key: str) -> list:
    """Generate embedding using Gemini's embedding model."""
    genai.configure(api_key=api_key)
    
    try:
        # Use Gemini's embedding model
        result = genai.embed_content(
            model="models/embedding-001",
            content=text,
            task_type="retrieval_document"
        )
        return result['embedding']
    except Exception as e:
        print(f"❌ Error generating embedding: {e}")
        # Try alternative API format
        try:
            result = genai.embed_content(
                model="models/embedding-001",
                content=text
            )
            return result['embedding']
        except Exception as e2:
            print(f"❌ Alternative embedding API also failed: {e2}")
            raise


def create_star_format_text(experience: dict) -> str:
    """Create STAR format text for the prompt."""
    return f"""EXPERIENCE {experience['id']} - {experience['title']}:
Situation: "{experience['situation']}"

Task: "{experience['task']}"

Action: "{experience['action']}"

Result: "{experience['result']}"
"""


def main():
    """Main ingestion function."""
    # Check for API key
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("❌ Error: GEMINI_API_KEY environment variable not set")
        print("Please set it: export GEMINI_API_KEY='your-api-key'")
        sys.exit(1)
    
    # Load experiences
    experiences = load_experiences()
    
    # Initialize ChromaDB
    # Store vector DB in ./chroma_db directory
    db_path = Path("./chroma_db")
    db_path.mkdir(exist_ok=True)
    
    print("📦 Initializing ChromaDB...")
    client = chromadb.PersistentClient(path=str(db_path))
    
    # Create or get collection - use "experience_store" as specified
    collection_name = "experience_store"
    try:
        collection = client.get_collection(name=collection_name)
        print(f"📖 Found existing collection: {collection_name}")
        print(f"   Current documents: {collection.count()}")
        
        # Ask if user wants to recreate
        response = input("Do you want to recreate the collection? (y/N): ").strip().lower()
        if response == 'y':
            client.delete_collection(name=collection_name)
            collection = client.create_collection(name=collection_name)
            print(f"✅ Recreated collection: {collection_name}")
        else:
            print("⚠️  Keeping existing collection. Exiting.")
            return
    except Exception:
        collection = client.create_collection(name=collection_name)
        print(f"✅ Created new collection: {collection_name}")
    
    # Initialize text splitter for chunking
    print("\n📝 Chunking descriptions (chunk_size=300, overlap=50)...")
    
    # Process each experience
    print(f"\n🔄 Processing {len(experiences)} experiences...")
    
    ids = []
    embeddings = []
    documents = []
    metadatas = []
    
    chunk_count = 0
    
    for i, exp in enumerate(experiences, 1):
        print(f"   Processing {i}/{len(experiences)}: {exp['title']}...")
        
        # Chunk the description field
        description_chunks = chunk_description(exp.get('description', ''))
        
        if not description_chunks or (len(description_chunks) == 1 and not description_chunks[0].strip()):
            # If no description or empty, use a single chunk with full experience text
            print(f"      ⚠️  No description found, using full experience text")
            description_chunks = [
                f"Title: {exp['title']}\nCompany: {exp['company']}\n"
                f"Situation: {exp.get('situation', '')}\n"
                f"Task: {exp.get('task', '')}\n"
                f"Action: {exp.get('action', '')}\n"
                f"Result: {exp.get('result', '')}"
            ]
        else:
            # Prepend title and company to each chunk for better context
            description_chunks = [
                f"Title: {exp['title']}\nCompany: {exp['company']}\nDescription: {chunk}"
                for chunk in description_chunks
            ]
        
        # Process each chunk
        for chunk_idx, chunk_text in enumerate(description_chunks):
            chunk_id = f"exp_{exp['id']}_chunk_{chunk_idx}"
            
            # Generate embedding for this chunk
            try:
                embedding = get_embedding(chunk_text, api_key)
            except Exception as e:
                print(f"      ❌ Failed to generate embedding for chunk {chunk_idx}: {e}")
                continue
            
            # Store data with metadata
            ids.append(chunk_id)
            embeddings.append(embedding)
            documents.append(chunk_text)
            metadatas.append({
                "experience_id": exp['id'],
                "title": exp['title'],
                "company": exp['company'],
                "chunk_index": chunk_idx,
                "total_chunks": len(description_chunks),
                "star_format": create_star_format_text(exp)  # Store full STAR format for retrieval
            })
            chunk_count += 1
        
        print(f"      ✅ Created {len(description_chunks)} chunk(s) for this experience")
    
    # Batch add to ChromaDB
    if ids:
        print(f"\n💾 Storing {len(ids)} chunks in ChromaDB collection '{collection_name}'...")
        
        # ChromaDB has a limit on batch size, so we'll process in batches
        batch_size = 100
        total_batches = (len(ids) + batch_size - 1) // batch_size
        
        for batch_idx in range(total_batches):
            start_idx = batch_idx * batch_size
            end_idx = min((batch_idx + 1) * batch_size, len(ids))
            
            batch_ids = ids[start_idx:end_idx]
            batch_embeddings = embeddings[start_idx:end_idx]
            batch_documents = documents[start_idx:end_idx]
            batch_metadatas = metadatas[start_idx:end_idx]
            
            collection.add(
                ids=batch_ids,
                embeddings=batch_embeddings,
                documents=batch_documents,
                metadatas=batch_metadatas
            )
            
            print(f"   ✅ Stored batch {batch_idx + 1}/{total_batches} ({len(batch_ids)} chunks)")
        
        print(f"\n✅ Successfully ingested {len(ids)} chunks from {len(experiences)} experiences!")
        print(f"   Collection name: {collection_name}")
        print(f"   Database location: {db_path.absolute()}")
        print(f"   Average chunks per experience: {len(ids) / len(experiences):.2f}")
    else:
        print("❌ No chunks were successfully processed")


if __name__ == "__main__":
    main()
