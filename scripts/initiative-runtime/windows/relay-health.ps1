function Test-VizorRelay([int]$Port) {
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/webhooks/github")
        $request.Method = 'POST'
        $request.Timeout = 3000
        $request.ContentLength = 0
        $response = $request.GetResponse()
        $response.Close()
        return $false
    } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $reply = if ($failure -is [Net.WebException]) { $failure.Response } else { $null }
        if (-not $reply) { return $false }
        try {
            if ([int]$reply.StatusCode -ne 401) { return $false }
            $reader = New-Object IO.StreamReader($reply.GetResponseStream())
            try { $data = $reader.ReadToEnd() | ConvertFrom-Json }
            finally { $reader.Dispose() }
            return $data.error -eq 'Invalid signature.'
        } catch {
            return $false
        } finally {
            $reply.Close()
        }
    }
}
