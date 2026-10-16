using System.Net;
using System.Net.Sockets;

namespace NotepadHub.Core;

/// <summary>
/// Downloads a picture that was copied from a web page, so the note keeps it after the page or the connection is gone.
/// The page text says where the picture is; nothing here trusts it: only http(s), only public internet addresses (checked on the
/// address actually connected to, so a name that later points inside the network is refused too), at most three redirects, ten seconds,
/// ten megabytes, no cookies and no credentials. What the bytes really are is decided later by <see cref="NoteStore.SaveAsset"/> from the first bytes.
/// </summary>
public sealed class ImageFetcher : IDisposable
{
    public const int MaxRedirects = 3;
    private readonly HttpClient _http;
    private readonly bool _allowLocal;

    /// <param name="allowLocal">Tests only: let the picture come from this computer.</param>
    public ImageFetcher(bool allowLocal = false)
    {
        _allowLocal = allowLocal;
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseProxy = false,
            ConnectTimeout = TimeSpan.FromSeconds(8),
            ConnectCallback = async (context, ct) =>
            {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct);
                var allowed = addresses.Where(a => _allowLocal || NetworkGuard.IsPublicAddress(a)).ToArray();
                if (allowed.Length == 0) throw new HttpRequestException("Адрес картинки не относится к публичному интернету.");
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(allowed, context.DnsEndPoint.Port, ct);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch { socket.Dispose(); throw; }
            },
        };
        _http = new HttpClient(handler, disposeHandler: true) { Timeout = TimeSpan.FromSeconds(10) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) NotepadHub4");
        _http.DefaultRequestHeaders.Accept.ParseAdd("image/png,image/jpeg,image/gif,image/webp,*/*;q=0.1");
    }

    /// <summary>Public-address rules live in <see cref="NetworkGuard"/>; this stays for the callers that name the fetcher.</summary>
    public static bool IsPublic(IPAddress a) => NetworkGuard.IsPublicAddress(a);

    public static bool IsAllowedUrl(string url, out Uri uri) =>
        Uri.TryCreate(url, UriKind.Absolute, out uri!) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) && string.IsNullOrEmpty(uri.UserInfo);

    public async Task<byte[]> FetchAsync(string url, CancellationToken ct)
    {
        if (!IsAllowedUrl(url, out var uri)) throw new InvalidDataException("Адрес картинки должен начинаться с http:// или https://.");
        for (var hop = 0; hop <= MaxRedirects; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is { } next)
            {
                var target = next.IsAbsoluteUri ? next : new Uri(uri, next);
                if (!IsAllowedUrl(target.ToString(), out uri)) throw new InvalidDataException("Картинка перенаправлена на недопустимый адрес.");
                continue;
            }
            if (!response.IsSuccessStatusCode) throw new InvalidDataException($"Сайт ответил HTTP {(int)response.StatusCode}.");
            if (response.Content.Headers.ContentLength is > NoteStore.AssetLimitBytes) throw new InvalidDataException("Изображение больше 10 МБ.");
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > NoteStore.AssetLimitBytes) throw new InvalidDataException("Изображение больше 10 МБ.");
            }
            return buffer.ToArray();
        }
        throw new InvalidDataException("Слишком много перенаправлений.");
    }

    public void Dispose() => _http.Dispose();
}
