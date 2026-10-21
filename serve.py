"""Local static preview. No production API, user authentication, or shared database."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import webbrowser


def main():
    parser = argparse.ArgumentParser(description="鼎峰管理平台本地预览")
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent / "dist"
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as error:
        raise SystemExit(f"无法启动端口 {args.port}：{error}。可使用 --port 4174 更换端口。")
    url = f"http://127.0.0.1:{args.port}"
    print(f"鼎峰管理平台：{url}\n请保留此窗口；按 Control+C 停止。", flush=True)
    if args.open:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
