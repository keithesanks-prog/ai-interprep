#!/usr/bin/env python3
"""
Ingest technical Q&A pairs into ChromaDB vector database using Gemini embeddings.

This script:
1. Loads technical Q&A from technical_qa.json
2. Chunks the question and answer fields
3. Generates embeddings using Google's Gemini embedding model
4. Stores them in ChromaDB for efficient retrieval

Usage:
    python ingest_technical_qa.py
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


def load_technical_qa(json_path: str = "technical_qa.json"):
    """Load technical Q&A from JSON file."""
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            qa_pairs = json.load(f)
        print(f"✅ Loaded {len(qa_pairs)} technical Q&A pairs from {json_path}")
        return qa_pairs
    except FileNotFoundError:
        print(f"❌ Error: {json_path} not found")
        print(f"   Creating empty {json_path} file...")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump([], f)
        return []
    except json.JSONDecodeError as e:
        print(f"❌ Error parsing JSON: {e}")
        sys.exit(1)


def chunk_text(text: str, chunk_size: int = 300, chunk_overlap: int = 50):
    """Chunk text into smaller pieces."""
    if not text or len(text.strip()) == 0:
        return [text] if text else [""]
    
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=len,
        separators=["\n\n", "\n", ". ", " ", ""]
    )
    
    chunks = text_splitter.split_text(text)
    return chunks


def get_embedding(text: str, api_key: str) -> list:
    """Generate embedding using Gemini's embedding model."""
    genai.configure(api_key=api_key)
    
    try:
        result = genai.embed_content(
            model="models/embedding-001",
            content=text,
            task_type="retrieval_document"
        )
        return result['embedding']
    except Exception as e:
        print(f"❌ Error generating embedding: {e}")
        try:
            result = genai.embed_content(
                model="models/embedding-001",
                content=text
            )
            return result['embedding']
        except Exception as e2:
            print(f"❌ Alternative embedding API also failed: {e2}")
            raise


def create_text_for_embedding(qa: dict) -> str:
    """Create a searchable text representation of a Q&A pair."""
    parts = [
        f"Question: {qa.get('question', '')}",
        f"Answer: {qa.get('answer', '')}",
    ]
    
    if qa.get('tags'):
        parts.append(f"Tags: {', '.join(qa.get('tags', []))}")
    if qa.get('category'):
        parts.append(f"Category: {qa.get('category', '')}")
    
    return "\n\n".join(parts)


def main():
    """Main ingestion function."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("❌ Error: GEMINI_API_KEY environment variable not set")
        print("Please set it: export GEMINI_API_KEY='your-api-key'")
        sys.exit(1)
    
    # Load technical Q&A
    qa_pairs = load_technical_qa()
    
    if len(qa_pairs) == 0:
        print("⚠️  No Q&A pairs found. Please add some to technical_qa.json first.")
        return
    
    # Initialize ChromaDB
    db_path = Path("./chroma_db")
    db_path.mkdir(exist_ok=True)
    
    print("📦 Initializing ChromaDB...")
    client = chromadb.PersistentClient(path=str(db_path))
    
    # Create or get collection
    collection_name = "technical_qa"
    try:
        collection = client.get_collection(name=collection_name)
        print(f"📖 Found existing collection: {collection_name}")
        print(f"   Current documents: {collection.count()}")
        
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
    
    # Process each Q&A pair
    print(f"\n🔄 Processing {len(qa_pairs)} technical Q&A pairs...")
    
    ids = []
    embeddings = []
    documents = []
    metadatas = []
    
    for i, qa in enumerate(qa_pairs, 1):
        print(f"   Processing {i}/{len(qa_pairs)}: Q#{qa.get('id', i)}...")
        
        # Create searchable text (question + answer + tags)
        searchable_text = create_text_for_embedding(qa)
        
        # For Q&A, we can chunk the answer if it's long
        answer = qa.get('answer', '')
        if len(answer) > 500:
            # Chunk the answer separately
            answer_chunks = chunk_text(answer)
            for chunk_idx, answer_chunk in enumerate(answer_chunks):
                chunk_text_content = f"Question: {qa.get('question', '')}\n\nAnswer (part {chunk_idx + 1}): {answer_chunk}"
                if qa.get('tags'):
                    chunk_text_content += f"\n\nTags: {', '.join(qa.get('tags', []))}"
                if qa.get('category'):
                    chunk_text_content += f"\nCategory: {qa.get('category', '')}"
                
                chunk_id = f"qa_{qa.get('id', i)}_chunk_{chunk_idx}"
                
                try:
                    embedding = get_embedding(chunk_text_content, api_key)
                except Exception as e:
                    print(f"      ❌ Failed to generate embedding for chunk {chunk_idx}: {e}")
                    continue
                
                ids.append(chunk_id)
                embeddings.append(embedding)
                documents.append(chunk_text_content)
                metadatas.append({
                    "qa_id": qa.get('id', i),
                    "question": qa.get('question', '')[:200],  # Truncate for metadata
                    "answer": answer[:500],  # Store full answer reference
                    "tags": ", ".join(qa.get('tags', [])),
                    "category": qa.get('category', ''),
                    "chunk_index": chunk_idx,
                    "total_chunks": len(answer_chunks),
                })
        else:
            # Single chunk for shorter answers
            chunk_id = f"qa_{qa.get('id', i)}"
            
            try:
                embedding = get_embedding(searchable_text, api_key)
            except Exception as e:
                print(f"      ❌ Failed to generate embedding: {e}")
                continue
            
            ids.append(chunk_id)
            embeddings.append(embedding)
            documents.append(searchable_text)
            metadatas.append({
                "qa_id": qa.get('id', i),
                "question": qa.get('question', '')[:200],
                "answer": answer[:500],
                "tags": ", ".join(qa.get('tags', [])),
                "category": qa.get('category', ''),
                "chunk_index": 0,
                "total_chunks": 1,
            })
    
    # Batch add to ChromaDB
    if ids:
        print(f"\n💾 Storing {len(ids)} Q&A chunks in ChromaDB collection '{collection_name}'...")
        
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
        
        print(f"\n✅ Successfully ingested {len(ids)} chunks from {len(qa_pairs)} Q&A pairs!")
        print(f"   Collection name: {collection_name}")
        print(f"   Database location: {db_path.absolute()}")
    else:
        print("❌ No Q&A chunks were successfully processed")


if __name__ == "__main__":
    main()

