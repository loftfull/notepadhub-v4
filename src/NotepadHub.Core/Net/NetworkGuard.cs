using System.Net;
using System.Net.Sockets;

namespace NotepadHub.Core;

/// <summary>
/// One network gate for every request that leaves the app towards the internet (pictures, OpenRouter,
/// an OpenAI-compatible service the owner configured). The public-address rules live here once:
/// <list type="bullet">
/// <item>the address is judged on the socket that is actually connected to, so a name that resolves (or later
/// re-resolves — DNS rebinding) to a private, loopback, link-local or metadata address is refused even though
/// the name itself looked public;</item>
/// <item>proxy is disabled by default: a proxy would resolve names itself and the pinning below could not judge
/// the real destination (the picture fetcher already worked this way). Users behind a corporate proxy can opt in
/// with <c>NOTEPADHUB_USE_PROXY=1</c> — see <see cref="SystemProxyRequested"/>;</item>
/// <item>cookies are disabled: the app never needs them and they could carry identity between services.</item>
/// </list>
/// Local servers (Ollama, LM Studio, vLLM on 127.0.0.1) are called through a different client that this guard
/// does not touch — see <c>AiService</c>, which keeps the injected client for loopback and uses a guarded one
/// for the internet.
/// </summary>
public static class NetworkGuard
{
    /// <summary>True only for addresses of the public internet (IPv4 and IPv6, including embedded-IPv4 forms).</summary>
    public static bool IsPublicAddress(IPAddress a)
    {
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (IPAddress.IsLoopback(a) || a.Equals(IPAddress.Any) || a.Equals(IPAddress.IPv6Any) || a.Equals(IPAddress.None)) return false;
        if (a.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (a.IsIPv6LinkLocal || a.IsIPv6SiteLocal || a.IsIPv6Multicast || a.IsIPv6Teredo) return false;
            var b6 = a.GetAddressBytes();
            if ((b6[0] & 0xFE) == 0xFC) return false;   // fc00::/7 unique local
            // addresses that carry an IPv4 address inside are judged by that address
            if (b6[0] == 0x00 && b6[1] == 0x64 && b6[2] == 0xFF && b6[3] == 0x9B && b6.Take(12).Skip(4).All(x => x == 0)) return IsPublicAddress(new IPAddress(b6.Skip(12).ToArray()));   // 64:ff9b::/96 (NAT64)
            if (b6[0] == 0x20 && b6[1] == 0x02) return IsPublicAddress(new IPAddress(b6.Skip(2).Take(4).ToArray()));                                                                       // 2002::/16 (6to4)
            if (b6.Take(12).All(x => x == 0)) return IsPublicAddress(new IPAddress(b6.Skip(12).ToArray()));                                                                                 // ::a.b.c.d (IPv4-compatible)
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

    /// <summary>Connect callback that resolves the name itself and only connects to public addresses of the answer.</summary>
    public static Func<SocketsHttpConnectionContext, CancellationToken, ValueTask<Stream>> PublicOnlyConnectCallback()
    {
        return async (context, ct) =>
        {
            var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct);
            var allowed = addresses.Where(IsPublicAddress).ToArray();
            if (allowed.Length == 0) throw new HttpRequestException("Адрес сервиса не относится к публичному интернету.");
            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(allowed, context.DnsEndPoint.Port, ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch { socket.Dispose(); throw; }
        };
    }

    /// <summary>
    /// Opt-in for users whose only route to the internet is a corporate proxy: with
    /// <c>NOTEPADHUB_USE_PROXY=1</c> the system proxy is used for remote AI and picture downloads.
    /// This is a trust decision: behind a proxy the guard below sees the proxy's address (usually private)
    /// and the real destination is resolved inside the proxy, so the per-IP pinning is disabled in that mode.
    /// </summary>
    public static bool SystemProxyRequested => Environment.GetEnvironmentVariable("NOTEPADHUB_USE_PROXY") == "1";

    /// <summary>A handler for calls to the internet: pinned to public addresses, no proxy, no cookies.</summary>
    public static SocketsHttpHandler CreatePublicOnlyHandler(bool allowSystemProxy = false) => new()
    {
        UseCookies = false,
        UseProxy = allowSystemProxy,
        ConnectTimeout = TimeSpan.FromSeconds(8),
        ConnectCallback = allowSystemProxy ? null : PublicOnlyConnectCallback(),
    };

    /// <summary>An <see cref="HttpClient"/> for calls to the internet with the public-address guard on every connection.</summary>
    public static HttpClient CreatePublicOnlyHttpClient(TimeSpan timeout, string userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NotepadHub4", bool allowSystemProxy = false)
    {
        var http = new HttpClient(CreatePublicOnlyHandler(allowSystemProxy), disposeHandler: true) { Timeout = timeout };
        http.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
        return http;
    }
}
