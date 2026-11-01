from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"pulse-ok")
    def log_message(self, *a):
        pass
HTTPServer(("0.0.0.0", 3000), H).serve_forever()
