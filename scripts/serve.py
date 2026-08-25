#!/usr/bin/env python3
"""
開発用の簡易サーバー。キャッシュを無効にして配信する。

スレッド版を使う。単スレッドだと、ブラウザが接続を開いたまま待つ場面で
サーバー全体が止まってしまい、以降のリクエストが一切返らなくなる。
"""
import http.server, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8160
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *a):
        pass


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', PORT), Handler) as httpd:
    print(f'serving {os.path.abspath(ROOT)} on http://localhost:{PORT}', flush=True)
    httpd.serve_forever()
