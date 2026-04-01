from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from backend.api.routes import router
from backend.database.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan — runs init_db() on startup.
    Using the modern lifespan approach (replaces deprecated @app.on_event('startup')).
    """
    await init_db()
    yield
    # (cleanup on shutdown can go here if needed)


app = FastAPI(
    title="Dots & Boxes AI Battle Suite",
    description="Multi-mode Dots and Boxes with Minimax, Alpha-Beta, and Adaptive AI.",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")

# Serve the SPA locally when static assets exist in the runtime bundle.
for candidate in (Path("public"), Path("frontend")):
    if candidate.exists():
        app.mount("/", StaticFiles(directory=str(candidate), html=True), name="frontend")
        break
