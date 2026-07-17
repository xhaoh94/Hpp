package com.hpp.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "HppUpdater")
public class HppUpdaterPlugin extends Plugin {
    private static final long MAX_APK_BYTES = 220L * 1024L * 1024L;
    private static final int MAX_REDIRECTS = 6;
    private static final Set<String> ALLOWED_HOSTS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com"
    )));
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String downloadUrl = call.getString("url", "").trim();
        String expectedSha = normalizeSha256(call.getString("sha256", ""));
        if (!isAllowedUrl(downloadUrl) || expectedSha == null) {
            call.reject("更新地址或校验信息无效", "UPDATE_REQUEST_INVALID");
            return;
        }

        executor.execute(() -> {
            File target = getUpdateFile();
            File temporary = new File(target.getParentFile(), target.getName() + ".download");
            try {
                if (!target.getParentFile().exists() && !target.getParentFile().mkdirs()) {
                    throw new IllegalStateException("Unable to create update cache directory");
                }
                if (temporary.exists() && !temporary.delete()) {
                    throw new IllegalStateException("Unable to replace temporary update");
                }
                download(downloadUrl, temporary);
                verifySha256(temporary, expectedSha);
                if (target.exists() && !target.delete()) {
                    throw new IllegalStateException("Unable to replace cached update");
                }
                if (!temporary.renameTo(target)) {
                    copyFile(temporary, target);
                    deleteQuietly(temporary);
                }
                finishInstallRequest(call, target);
            } catch (ChecksumException error) {
                deleteQuietly(temporary);
                deleteQuietly(target);
                call.reject("安装包校验失败", "CHECKSUM_MISMATCH", error);
            } catch (DownloadTooLargeException error) {
                deleteQuietly(temporary);
                call.reject("安装包大小异常", "DOWNLOAD_TOO_LARGE", error);
            } catch (Exception error) {
                deleteQuietly(temporary);
                call.reject("安装包下载失败", "DOWNLOAD_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || canInstallPackages()) {
            JSObject result = new JSObject();
            result.put("opened", false);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())
        );
        getActivity().startActivity(intent);
        JSObject result = new JSObject();
        result.put("opened", true);
        call.resolve(result);
    }

    @PluginMethod
    public void installDownloaded(PluginCall call) {
        String expectedSha = normalizeSha256(call.getString("sha256", ""));
        if (expectedSha == null) {
            call.reject("校验信息无效", "UPDATE_REQUEST_INVALID");
            return;
        }
        File target = getUpdateFile();
        if (!target.isFile()) {
            call.reject("安装包已失效", "INSTALL_FILE_MISSING");
            return;
        }
        executor.execute(() -> {
            try {
                verifySha256(target, expectedSha);
                finishInstallRequest(call, target);
            } catch (ChecksumException error) {
                deleteQuietly(target);
                call.reject("安装包校验失败", "CHECKSUM_MISMATCH", error);
            } catch (Exception error) {
                call.reject("无法打开系统安装器", "INSTALL_FAILED", error);
            }
        });
    }

    private void finishInstallRequest(PluginCall call, File apk) {
        if (!canInstallPackages()) {
            JSObject result = new JSObject();
            result.put("status", "permission-required");
            call.resolve(result);
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    apk
                );
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(intent);
                JSObject result = new JSObject();
                result.put("status", "install-started");
                call.resolve(result);
            } catch (Exception error) {
                call.reject("无法打开系统安装器", "INSTALL_FAILED", error);
            }
        });
    }

    private void download(String source, File target) throws Exception {
        IOException lastFailure = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                downloadOnce(source, target);
                return;
            } catch (IOException error) {
                lastFailure = error;
                deleteQuietly(target);
            }
        }
        throw lastFailure;
    }

    private void downloadOnce(String source, File target) throws Exception {
        HttpURLConnection connection = openConnection(source);
        long total = connection.getContentLengthLong();
        if (total > MAX_APK_BYTES) throw new DownloadTooLargeException();
        long downloaded = 0;
        int lastProgress = -1;
        try (
            InputStream input = new BufferedInputStream(connection.getInputStream());
            BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(target))
        ) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                downloaded += count;
                if (downloaded > MAX_APK_BYTES) throw new DownloadTooLargeException();
                output.write(buffer, 0, count);
                int progress = total > 0 ? (int) Math.min(100, downloaded * 100 / total) : -1;
                if (progress != lastProgress) {
                    lastProgress = progress;
                    JSObject event = new JSObject();
                    event.put("progress", progress);
                    event.put("downloadedBytes", downloaded);
                    event.put("totalBytes", total);
                    notifyListeners("downloadProgress", event);
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection openConnection(String source) throws Exception {
        URL url = new URL(source);
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            if (!"https".equalsIgnoreCase(url.getProtocol()) || !ALLOWED_HOSTS.contains(url.getHost().toLowerCase(Locale.ROOT))) {
                throw new SecurityException("Update redirect host is not allowed");
            }
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            connection.setRequestProperty("User-Agent", "Hpp-Android-Updater");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Connection", "close");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null) throw new IllegalStateException("Update redirect is missing a location");
                url = new URL(url, location);
                continue;
            }
            if (status < 200 || status >= 300) {
                connection.disconnect();
                throw new IllegalStateException("Update download returned HTTP " + status);
            }
            return connection;
        }
        throw new IllegalStateException("Too many update redirects");
    }

    private void verifySha256(File file, String expected) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder actual = new StringBuilder();
        for (byte value : digest.digest()) actual.append(String.format(Locale.ROOT, "%02x", value));
        if (!MessageDigest.isEqual(
            actual.toString().getBytes(StandardCharsets.US_ASCII),
            expected.getBytes(StandardCharsets.US_ASCII)
        )) throw new ChecksumException();
    }

    private boolean canInstallPackages() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            getContext().getPackageManager().canRequestPackageInstalls();
    }

    private File getUpdateFile() {
        return new File(new File(getContext().getCacheDir(), "updates"), "Hpp-update.apk");
    }

    private static String normalizeSha256(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        return normalized.matches("^[a-f0-9]{64}$") ? normalized : null;
    }

    private static boolean isAllowedUrl(String value) {
        try {
            URL url = new URL(value);
            return "https".equalsIgnoreCase(url.getProtocol()) &&
                ALLOWED_HOSTS.contains(url.getHost().toLowerCase(Locale.ROOT));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void copyFile(File source, File target) throws Exception {
        try (
            InputStream input = new BufferedInputStream(new FileInputStream(source));
            BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(target))
        ) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
    }

    private static void deleteQuietly(File file) {
        if (file.exists()) file.delete();
    }

    private static final class ChecksumException extends Exception {}
    private static final class DownloadTooLargeException extends Exception {}
}
