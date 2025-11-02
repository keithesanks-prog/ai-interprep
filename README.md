This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## AI Interview Assistant with RAG

This application uses Retrieval-Augmented Generation (RAG) to provide context-aware interview responses based on a library of 33 professional experiences.

## Setup

### 1. Install Dependencies

**Node.js dependencies:**
```bash
npm install
```

**Python dependencies (for RAG system):**
```bash
pip install -r requirements.txt
```

### 2. Set Environment Variables

Create a `.env.local` file in the root directory:
```bash
GEMINI_API_KEY=your_gemini_api_key_here
RAG_API_URL=http://localhost:8000  # Optional, defaults to localhost:8000
```

### 3. Initialize Vector Database

**For experiences:**
```bash
python ingest.py
```

**For technical Q&A:**
```bash
python ingest_technical_qa.py
```

These will:
- Load experiences/Q&A from JSON files
- Generate embeddings using Gemini's `models/embedding-001`
- Store them in `./chroma_db/` directory

### 4. Start Next.js Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Project Structure

- `experiences.json` - All 33 experiences in JSON format
- `technical_qa.json` - Technical Q&A pairs for interview preparation
- `ingest.py` - Script to create vector database from experiences
- `ingest_technical_qa.py` - Script to create vector database from technical Q&A
- `rag_api.py` - Python FastAPI server for RAG retrieval (optional, now using direct ChromaDB)
- `app/api/generate/route.ts` - Next.js API route that uses RAG to retrieve relevant experiences and Q&A
- `app/api/rag_utils.ts` - RAG utility functions for retrieval
- `app/page.tsx` - Frontend React component

## How RAG Works

1. **Question comes in** → Extracted from user prompt
2. **Query embedding** → Generated using Gemini's embedding model
3. **Semantic search** → ChromaDB finds top 5 most relevant experiences + top 3 technical Q&A pairs
4. **Prompt augmentation** → Retrieved experiences and Q&A are included in the system instruction
5. **Response generation** → Gemini generates answer using retrieved context

This approach is more efficient than hardcoding all experiences in every prompt, reducing token usage and improving relevance. Technical Q&A pairs provide ready-made answers for common technical interview questions.

## Adding New Content

### Adding New Experiences

1. Add new experience to `experiences.json`
2. Run `python ingest.py` again (it will prompt to recreate the collection)
3. The new experience will be available for retrieval

### Adding Technical Q&A

1. Add new Q&A pair to `technical_qa.json` with this format:
```json
{
  "id": 9,
  "question": "Your technical question here",
  "answer": "Your detailed answer here. Include code snippets, commands, or queries as needed.",
  "tags": ["Tag1", "Tag2", "Tag3"],
  "category": "Category Name"
}
```

2. Run `python ingest_technical_qa.py` to update the vector database
3. The Q&A will be automatically retrieved when relevant questions are asked during interviews

**Example Q&A Format:**
- Include specific commands, queries, or code snippets in answers
- Add relevant tags for better searchability
- Use descriptive categories (e.g., "SIEM/Logging", "Cloud Security", "Detection")

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
