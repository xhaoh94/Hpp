package com.hpp.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
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
    private static final long NO_DOWNLOAD = -1L;
    private static final String UPDATE_FILE_NAME = "Hpp-update.apk";
    private static final String PREFERENCES_NAME = "hpp-android-updater";
    private static final String KEY_DOWNLOAD_ID = "downloadId";
    private static final String KEY_DOWNLOAD_SHA = "downloadSha";
    private static final String KEY_COMPLETED_SHA = "completedSha";
    private static final Set<String> ALLOWED_HOSTS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com"
    )));
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void startDownload(PluginCall call) {
        String downloadUrl = call.getString("url", "").trim();
        String expectedSha = normalizeSha256(call.getString("sha256", ""));
        if (!isAllowedUrl(downloadUrl) || expectedSha == null) {
            call.reject("更新地址或校验信息无效", "UPDATE_REQUEST_INVALID");
            return;
        }

        EXECUTOR.execute(() -> {
            try {
                JSObject current = readUpdateStatus(expectedSha);
                String status = current.getString("status");
                if ("downloading".equals(status) || "downloaded".equals(status)) {
                    call.resolve(current);
                    return;
                }
                call.resolve(enqueueDownload(downloadUrl, expectedSha));
            } catch (Exception error) {
                call.reject("安装包下载失败", "DOWNLOAD_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void getUpdateStatus(PluginCall call) {
        String expectedSha = normalizeSha256(call.getString("sha256", ""));
        if (expectedSha == null) {
            call.reject("校验信息无效", "UPDATE_REQUEST_INVALID");
            return;
        }
        EXECUTOR.execute(() -> {
            try {
                call.resolve(readUpdateStatus(expectedSha));
            } catch (Exception error) {
                call.reject("无法读取下载状态", "DOWNLOAD_STATUS_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || canInstallPackages()) {
            call.resolve(permissionResult(false));
            return;
        }
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())
        );
        startActivityForResult(call, intent, "installPermissionResult");
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve(permissionResult(true));
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
        EXECUTOR.execute(() -> {
            try {
                verifySha256(target, expectedSha);
                finishInstallRequest(call, target);
            } catch (ChecksumException error) {
                deleteQuietly(target);
                preferences().edit().remove(KEY_COMPLETED_SHA).apply();
                call.reject("安装包校验失败", "CHECKSUM_MISMATCH", error);
            } catch (Exception error) {
                call.reject("无法打开系统安装器", "INSTALL_FAILED", error);
            }
        });
    }

    private JSObject enqueueDownload(String source, String expectedSha) {
        clearActiveDownload(true);
        deleteQuietly(getUpdateFile());
        preferences().edit().remove(KEY_COMPLETED_SHA).apply();

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(source));
        request.setTitle("Hpp");
        request.setDescription("正在下载安装包");
        request.setMimeType("application/vnd.android.package-archive");
        request.setAllowedOverMetered(true);
        request.setAllowedOverRoaming(true);
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
        request.setDestinationInExternalFilesDir(
            getContext(),
            Environment.DIRECTORY_DOWNLOADS,
            UPDATE_FILE_NAME
        );

        long downloadId = downloadManager().enqueue(request);
        preferences().edit()
            .putLong(KEY_DOWNLOAD_ID, downloadId)
            .putString(KEY_DOWNLOAD_SHA, expectedSha)
            .apply();
        return statusResult("downloading", 0, 0, -1, null);
    }

    private JSObject readUpdateStatus(String expectedSha) throws Exception {
        File completed = getUpdateFile();
        String completedSha = preferences().getString(KEY_COMPLETED_SHA, "");
        if (completed.isFile() && expectedSha.equals(completedSha)) {
            return statusResult("downloaded", 100, completed.length(), completed.length(), null);
        }
        if (completed.exists()) {
            deleteQuietly(completed);
            preferences().edit().remove(KEY_COMPLETED_SHA).apply();
        }

        SharedPreferences state = preferences();
        long downloadId = state.getLong(KEY_DOWNLOAD_ID, NO_DOWNLOAD);
        String downloadSha = state.getString(KEY_DOWNLOAD_SHA, "");
        if (downloadId == NO_DOWNLOAD || !expectedSha.equals(downloadSha)) {
            if (downloadId != NO_DOWNLOAD) clearActiveDownload(true);
            return statusResult("idle", -1, 0, -1, null);
        }

        DownloadManager.Query query = new DownloadManager.Query().setFilterById(downloadId);
        try (Cursor cursor = downloadManager().query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                clearActiveDownload(true);
                return statusResult("idle", -1, 0, -1, null);
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int progress = total > 0 ? (int) Math.min(100, downloaded * 100 / total) : -1;

            if (total > MAX_APK_BYTES || downloaded > MAX_APK_BYTES) {
                clearActiveDownload(true);
                return statusResult("failed", progress, downloaded, total, "DOWNLOAD_TOO_LARGE");
            }
            if (
                status == DownloadManager.STATUS_PENDING ||
                status == DownloadManager.STATUS_RUNNING ||
                status == DownloadManager.STATUS_PAUSED
            ) {
                return statusResult("downloading", progress, downloaded, total, null);
            }
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                return finishCompletedDownload(downloadId, expectedSha, downloaded, total);
            }

            clearActiveDownload(true);
            return statusResult("failed", progress, downloaded, total, "DOWNLOAD_FAILED");
        }
    }

    private JSObject finishCompletedDownload(long downloadId, String expectedSha, long downloaded, long total) throws Exception {
        File temporary = getDownloadManagerFile();
        if (!temporary.isFile()) {
            clearActiveDownload(true);
            return statusResult("failed", -1, downloaded, total, "INSTALL_FILE_MISSING");
        }
        if (temporary.length() > MAX_APK_BYTES) {
            clearActiveDownload(true);
            return statusResult("failed", 100, temporary.length(), total, "DOWNLOAD_TOO_LARGE");
        }
        try {
            verifySha256(temporary, expectedSha);
        } catch (ChecksumException error) {
            clearActiveDownload(true);
            return statusResult("failed", 100, temporary.length(), total, "CHECKSUM_MISMATCH");
        }

        File target = getUpdateFile();
        if (!target.getParentFile().exists() && !target.getParentFile().mkdirs()) {
            throw new IllegalStateException("Unable to create update cache directory");
        }
        copyFile(temporary, target);
        preferences().edit().putString(KEY_COMPLETED_SHA, expectedSha).apply();
        downloadManager().remove(downloadId);
        clearActiveState();
        deleteQuietly(temporary);
        return statusResult("downloaded", 100, target.length(), target.length(), null);
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

    private JSObject permissionResult(boolean opened) {
        JSObject result = new JSObject();
        result.put("opened", opened);
        result.put("granted", canInstallPackages());
        return result;
    }

    private JSObject statusResult(String status, int progress, long downloaded, long total, String errorCode) {
        JSObject result = new JSObject();
        result.put("status", status);
        result.put("progress", progress);
        result.put("downloadedBytes", downloaded);
        result.put("totalBytes", total);
        if (errorCode != null) result.put("errorCode", errorCode);
        return result;
    }

    private DownloadManager downloadManager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private void clearActiveDownload(boolean deleteFile) {
        long downloadId = preferences().getLong(KEY_DOWNLOAD_ID, NO_DOWNLOAD);
        if (downloadId != NO_DOWNLOAD) downloadManager().remove(downloadId);
        clearActiveState();
        if (deleteFile) deleteQuietly(getDownloadManagerFile());
    }

    private void clearActiveState() {
        preferences().edit().remove(KEY_DOWNLOAD_ID).remove(KEY_DOWNLOAD_SHA).apply();
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
        return new File(new File(getContext().getCacheDir(), "updates"), UPDATE_FILE_NAME);
    }

    private File getDownloadManagerFile() {
        File downloads = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (downloads == null) throw new IllegalStateException("External downloads directory is unavailable");
        return new File(downloads, UPDATE_FILE_NAME);
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
        if (file != null && file.exists()) file.delete();
    }

    private static final class ChecksumException extends Exception {}
}
