#!/usr/bin/env python3
"""Minimal static file server for local preview.

Serves the project root over HTTP so the dashboard's fetch() calls work
(opening index.html via file:// is blocked by the browser). Avoids
http.server's CLI, which calls os.getcwd() and can fail under sandboxes.

Usage:  python3 scripts/serve.py        # then open http://127.0.0.1:8000
"""
import functools
import http.server
import os
import socketserver

DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("PORT", "8000"))

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIRECTORY)


class Server(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving {DIRECTORY} at http://127.0.0.1:{PORT}")
        httpd.serve_forever()
