from types import SimpleNamespace
from stockreplay import desk


def test_news_preview_keeps_only_feed_photos_and_plaintext(monkeypatch):
    good = "https://s.yimg.com/article.jpg"
    large = "https://media.zenfs.com/full.jpg"
    article = {
        "title": "Earnings report",
        "pubDate": "2026-11-24T19:30:00Z",
        "canonicalUrl": {"url": "https://example.org/article"},
        "contentType": "STORY",
        "summary": "<p>Shares rose on the earnings news.</p>",
        "byline": "<b>Jane Smith</b>",
        "provider": {"displayName": "Financial publication"},
        "finance": {"premiumFinance": {"isPremiumNews": True}},
        "thumbnail": {
            "originalUrl": large,
            "originalWidth": 1800,
            "originalHeight": 900,
            "resolutions": [
                {"url": good, "width": 660, "height": 330},
                {"url": large, "width": 1800, "height": 900},
                {"url": "https://example.org/unknown.jpg", "width": 740, "height": 360},
                {"url": "https://media.zenfs.com/pixel.gif", "width": 1, "height": 1},
            ],
        },
    }
    monkeypatch.setattr(
        desk.yf,
        "Ticker",
        lambda symbol: SimpleNamespace(get_news=lambda count: [None, {"content": article}]),
    )
    row = desk.stories("NVDA", "company")[0]
    assert (
        row["url"] == article["canonicalUrl"]["url"] and row["publisher"] == "Financial publication"
    )
    assert row["excerpt"] == "Shares rose on the earnings news."
    assert row["preview"] == {
        "images": [good, large],
        "format": "article",
        "byline": "Jane Smith",
        "subscription": True,
    }


def test_unusable_or_absent_thumbnails_preserve_the_news():
    for raw in [
        None,
        {"finance": 42, "thumbnail": "unavailable"},
        {
            "authors": [None, 42, {}],
            "thumbnail": {
                "resolutions": [
                    None,
                    False,
                    {
                        "url": "https://media.zenfs.com:8080/p.jpg",
                        "width": 600,
                        "height": 320,
                    },
                ]
            },
        },
    ]:
        assert desk.article_preview(raw or {})["images"] == []


def test_rss_uses_declared_media_and_published_attribution(monkeypatch):
    rss = b"""<rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
    <item><title>Market update</title><link>https://example.org/report</link>
    <pubDate>Tue, 24 Nov 2026 19:30:00 GMT</pubDate><dc:creator>Jane Doe</dc:creator>
    <media:thumbnail url="https://media.zenfs.com/article.jpg"/>
    <enclosure type="audio/mpeg" url="https://media.zenfs.com/report.mp3"/>
    <description><![CDATA[<img src="https://example.org/track"><p>Markets closed higher.</p>]]></description></item>
    </channel></rss>"""
    monkeypatch.setattr(desk, "fetch_url", lambda url: SimpleNamespace(content=rss))
    row = desk.rss("https://example.org/feed", "market")[0]
    assert row["preview"] == {
        "images": ["https://media.zenfs.com/article.jpg"],
        "byline": "Jane Doe",
    }
    assert row["excerpt"] == "Markets closed higher."


def test_local_image_route_fetches_only_registered_feed_photos(tmp_path, monkeypatch):
    from stockreplay.api import create_app
    from stockreplay import news_images
    from fastapi.testclient import TestClient

    app = create_app(tmp_path)
    refs = [
        {
            "preview": {
                "images": [
                    "https://media.zenfs.com/photo.png",
                    "http://127.0.0.1/secret",
                ]
            }
        }
    ]
    app.state.terminal.desk.photos.attach(refs)
    paths = refs[0]["preview"]["images"]
    assert len(paths) == 1 and paths[0].startswith("/api/news/images/")
    calls = []

    def photo(url):
        calls.append(url)
        return "image/png", b"cached public photo bytes"

    monkeypatch.setattr(news_images, "retrieve", photo)
    with TestClient(app) as client:
        assert client.get("/api/news/images/" + ("0" * 64)).status_code == 404
        assert not calls
        res = client.get(paths[0])
        assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    with TestClient(create_app(tmp_path)) as client:
        assert client.get(paths[0]).content == res.content
    assert calls == ["https://media.zenfs.com/photo.png"]


def test_media_download_rejects_nonimages_redirects_and_oversized_content(monkeypatch):
    from stockreplay import news_images
    import httpx

    replies = [
        httpx.Response(302, headers={"location": "https://example.org/redirect"}),
        httpx.Response(
            200,
            headers={"content-type": "image/jpeg"},
            content=b"<html>access denied</html>",
        ),
        httpx.Response(
            200,
            headers={
                "content-type": "image/png",
                "content-length": str(news_images.MAX_PHOTO + 1),
            },
        ),
        httpx.Response(200, headers={"content-type": "text/html"}, content=b"publisher login"),
        httpx.Response(
            200,
            headers={"content-type": "image/png"},
            content=news_images.SIGNATURES["image/png"] + b"extra",
        ),
    ]
    real_client = httpx.Client

    def transport(req):
        assert req.url.host == "s.yimg.com"
        return replies.pop(0)

    monkeypatch.setattr(
        news_images.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(transport), **kw),
    )
    assert news_images.retrieve("https://unknown.example/asset") is None
    assert all(news_images.retrieve("https://s.yimg.com/asset") is None for _ in range(4))
    assert news_images.retrieve("https://s.yimg.com/asset")[0] == "image/png"
    assert not replies
