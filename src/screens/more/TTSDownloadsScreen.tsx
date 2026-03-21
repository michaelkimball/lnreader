/**
 * TTS Downloads Screen
 * 
 * Displays and manages offline TTS audio downloads for chapters.
 * Users can view download status, cancel downloads, and delete downloaded content.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Appbar as MaterialAppbar } from 'react-native-paper';

import EmptyView from '@components/EmptyView';
import { Appbar, List, SafeAreaView } from '@components';
import { useTheme } from '@hooks/persisted';
import { getString } from '@strings/translations';
import { TTSDownloadRow } from '@database/schema';
import { getTTSDownloadsByStatus, deleteTTSDownload, getTTSDownloadStats } from '@database/queries/TTSDownloadQueries';
import { ttsDownloadManager, DownloadEvent } from '@services/tts/TTSDownloadManager';
import { showToast } from '@utils/showToast';
import dayjs from 'dayjs';

interface TTSDownloadsScreenProps {
  navigation: any; // TODO: Type this properly with navigator types
}

const TTSDownloadsScreen = ({ navigation }: TTSDownloadsScreenProps) => {
  const theme = useTheme();
  const [loading, setLoading] = useState(true);
  const [downloads, setDownloads] = useState<TTSDownloadRow[]>([]);
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    totalSizeMB: 0,
  });

  /**
   * Load downloads from database
   */
  const loadDownloads = async () => {
    try {
      // Get all downloads (completed + processing + pending)
      const [completed, processing, pending, failed] = await Promise.all([
        getTTSDownloadsByStatus('completed'),
        getTTSDownloadsByStatus('processing'),
        getTTSDownloadsByStatus('pending'),
        getTTSDownloadsByStatus('failed'),
      ]);

      const allDownloads = [...processing, ...pending, ...completed, ...failed];
      setDownloads(allDownloads);

      // Calculate stats
      const statsData = {
        total: allDownloads.length,
        pending: pending.length,
        processing: processing.length,
        completed: completed.length,
        failed: failed.length,
        totalSizeMB: allDownloads.reduce((sum, d) => sum + (d.totalSizeMB || 0), 0),
      };
      setStats(statsData);

      console.log('[TTSDownloadsScreen] Loaded downloads:', statsData);
    } catch (error) {
      console.error('[TTSDownloadsScreen] Failed to load downloads:', error);
      showToast('Failed to load downloads');
    }
  };

  /**
   * Handle download events from manager
   */
  const handleDownloadEvent = useCallback((event: DownloadEvent) => {
    console.log('[TTSDownloadsScreen] Download event:', event);
    
    switch (event.type) {
      case 'downloadCompleted':
        showToast('Download completed');
        loadDownloads();
        break;
      case 'downloadFailed':
        showToast(`Download failed: ${event.error}`);
        loadDownloads();
        break;
      case 'queueChanged':
        loadDownloads();
        break;
      case 'downloadProgress':
        // Update specific download progress (could update UI more granularly)
        loadDownloads();
        break;
    }
  }, []);

  /**
   * Delete a download
   */
  const handleDeleteDownload = async (download: TTSDownloadRow) => {
    try {
      await ttsDownloadManager.deleteDownload(download.chapterId);
      showToast('Download deleted');
      loadDownloads();
    } catch (error) {
      console.error('[TTSDownloadsScreen] Delete failed:', error);
      showToast('Failed to delete download');
    }
  };

  /**
   * Cancel a download
   */
  const handleCancelDownload = async (download: TTSDownloadRow) => {
    try {
      await ttsDownloadManager.cancelDownload(download.chapterId);
      showToast('Download cancelled');
      loadDownloads();
    } catch (error) {
      console.error('[TTSDownloadsScreen] Cancel failed:', error);
      showToast('Failed to cancel download');
    }
  };

  /**
   * Retry a failed download
   */
  const handleRetryDownload = async (download: TTSDownloadRow) => {
    try {
      // TODO: Implement retry - need to resubmit with original text elements
      showToast('Retry not yet implemented');
    } catch (error) {
      console.error('[TTSDownloadsScreen] Retry failed:', error);
      showToast('Failed to retry download');
    }
  };

  /**
   * Get status display text
   */
  const getStatusText = (download: TTSDownloadRow): string => {
    switch (download.status) {
      case 'pending':
        return 'Pending';
      case 'processing':
        const progress = download.totalElements > 0
          ? Math.round((download.downloadedElements / download.totalElements) * 100)
          : 0;
        return `Processing ${progress}%`;
      case 'completed':
        return `Completed • ${download.totalSizeMB?.toFixed(1)} MB`;
      case 'failed':
        return `Failed: ${download.errorMessage || 'Unknown error'}`;
      default:
        return download.status;
    }
  };

  /**
   * Get status color
   */
  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'completed':
        return theme.primary;
      case 'processing':
        return theme.onSurfaceVariant;
      case 'pending':
        return theme.onSurfaceVariant;
      case 'failed':
        return theme.error;
      default:
        return theme.onSurfaceVariant;
    }
  };

  /**
   * Render download item
   */
  const renderDownloadItem = ({ item }: { item: TTSDownloadRow }) => {
    const statusText = getStatusText(item);
    const statusColor = getStatusColor(item.status);
    const createdDate = dayjs(item.createdAt).format('MMM D, YYYY');

    return (
      <List.Item
        title={`Chapter ${item.chapterId}`} // TODO: Get actual chapter name
        description={`${statusText}\n${createdDate} • ${item.voiceName}`}
        descriptionStyle={{ color: statusColor }}
        onPress={() => {
          // TODO: Navigate to chapter or show details
        }}
        onLongPress={() => {
          if (item.status === 'completed') {
            handleDeleteDownload(item);
          } else if (item.status === 'processing' || item.status === 'pending') {
            handleCancelDownload(item);
          } else if (item.status === 'failed') {
            handleRetryDownload(item);
          }
        }}
        theme={theme}
      />
    );
  };

  /**
   * List empty component
   */
  const ListEmptyComponent = useCallback(
    () =>
      !loading ? (
        <EmptyView
          icon="🎧"
          description="No TTS downloads yet"
        />
      ) : null,
    [loading],
  );

  /**
   * List header with stats
   */
  const ListHeaderComponent = useCallback(() => {
    if (stats.total === 0) {
      return null;
    }

    return (
      <View style={styles.statsContainer}>
        <List.InfoText
          text={`${stats.completed} completed • ${stats.processing} processing • ${stats.pending} pending`}
          icon="information-outline"
          theme={theme}
        />
        {stats.totalSizeMB > 0 && (
          <List.InfoText
            text={`Total size: ${stats.totalSizeMB.toFixed(1)} MB`}
            icon="database-outline"
            theme={theme}
          />
        )}
      </View>
    );
  }, [stats, theme]);

  /**
   * Initialize and subscribe to events
   */
  useEffect(() => {
    loadDownloads().finally(() => setLoading(false));

    // Subscribe to download events
    ttsDownloadManager.on('downloadCompleted', handleDownloadEvent);
    ttsDownloadManager.on('downloadFailed', handleDownloadEvent);
    ttsDownloadManager.on('downloadProgress', handleDownloadEvent);
    ttsDownloadManager.on('queueChanged', handleDownloadEvent);

    return () => {
      ttsDownloadManager.off('downloadCompleted', handleDownloadEvent);
      ttsDownloadManager.off('downloadFailed', handleDownloadEvent);
      ttsDownloadManager.off('downloadProgress', handleDownloadEvent);
      ttsDownloadManager.off('queueChanged', handleDownloadEvent);
    };
  }, [handleDownloadEvent]);

  return (
    <SafeAreaView excludeTop>
      <Appbar
        title="TTS Downloads"
        handleGoBack={navigation.goBack}
        theme={theme}
      >
        {stats.total > 0 && (
          <MaterialAppbar.Action
            icon="refresh"
            iconColor={theme.onSurface}
            onPress={() => loadDownloads()}
          />
        )}
      </Appbar>
      
      <FlatList
        data={downloads}
        keyExtractor={(item) => item.id.toString()}
        renderItem={renderDownloadItem}
        ListHeaderComponent={ListHeaderComponent}
        ListEmptyComponent={ListEmptyComponent}
        contentContainerStyle={styles.container}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
  },
  statsContainer: {
    padding: 16,
  },
});

export default TTSDownloadsScreen;
