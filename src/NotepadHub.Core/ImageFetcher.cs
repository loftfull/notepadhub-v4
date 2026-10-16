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
                var allowed = addresses.Where(a => _allowLocal || IsPublic(a)).ToArray();
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

    public static bool IsPublic(IPAddress a)
    {
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (IPAddress.IsLoopback(a) || a.Equals(IPAddress.Any) || a.Equals(IPAddress.IPv6Any) || a.Equals(IPAddress.None)) return false;
        if (a.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (a.IsIPv6LinkLocal || a.IsIPv6SiteLocal || a.IsIPv6Multicast || a.IsIPv6Teredo) return false;
            var b6 = a.GetAddressBytes();
            if ((b6[0] & 0xFE) == 0xFC) return false;   // fc00::/7 unique local
            // addresses that carry an IPv4 address inside are judged by that address
            if (b6[0] == 0x00 && b6[1] == 0x64 && b6[2] == 0xFF && b6[3] == 0x9B && b6.Take(12).Skip(4).All(x => x == 0)) return IsPublic(new IPAddress(b6.Skip(12).ToArray()));   // 64:ff9b::/96 (NAT64)
            if (b6[0] == 0x20 && b6[1] == 0x02) return IsPublic(new IPAddress(b6.Skip(2).Take(4).ToArray()));                                                                       // 2002::/16 (6to4)
            if (b6.Take(12).All(x => x == 0)) return IsPublic(new IPAddress(b6.Skip(12).ToArray()));                                                                                 // ::a.b.c.d (IPv4-compatible)
            return true;
        }
        var b = a.GetAddressBytes();
        if (b[0] == 10 || b[0] == 127 || b[0] == 0) return false;
        if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return false;
        if (b[0] == 192 && b[1] == 168) return false;
        if (b[0] == 169 && b[1] == 254) return false;       // link-local, cloud metadata
        if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return false;   // carrier-grade NAT
        if (b[0] == 198 && (b[1] == 18 || b[1] == 19)) return false;   // benchmarking
        if (b[0] == 192 && b[1] == 0 && (b[2] == 0 || b[2] == 2)) return false;   // protocol assignments, documentation
        if (b[0] == 198 && b[1] == 51 && b[2] == 100) return false;   // documentation
        if (b[0] == 203 && b[1] == 0 && b[2] == 113) return false;    // documentation
        if (b[0] >= 224) return false;                        // multicast and reserved
        return true;
    }

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
