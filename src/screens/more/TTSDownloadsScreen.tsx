/**
 * TTS Downloads Screen
 *
 * Displays and manages offline TTS audio downloads for chapters.
 * Swipe left on a row to delete. Use the clear-all button in the app bar
 * to remove every download at once.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Appbar as MaterialAppbar } from 'react-native-paper';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import EmptyView from '@components/EmptyView';
import { Appbar, ConfirmationDialog, IconButtonV2, List, SafeAreaView } from '@components';
import { useTheme } from '@hooks/persisted';
import { TTSDownloadRow } from '@database/schema';
import { getTTSDownloadsByStatus } from '@database/queries/TTSDownloadQueries';
import { ttsDownloadManager, DownloadEvent } from '@services/tts/TTSDownloadManager';
import { showToast } from '@utils/showToast';
import dayjs from 'dayjs';

interface TTSDownloadsScreenProps {
  navigation: any;
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
  const [showClearAllDialog, setShowClearAllDialog] = useState(false);

  const loadDownloads = async () => {
    try {
      const [completed, processing, pending, failed] = await Promise.all([
        getTTSDownloadsByStatus('completed'),
        getTTSDownloadsByStatus('processing'),
        getTTSDownloadsByStatus('pending'),
        getTTSDownloadsByStatus('failed'),
      ]);

      const allDownloads = [...processing, ...pending, ...completed, ...failed];
      setDownloads(allDownloads);
      setStats({
        total: allDownloads.length,
        pending: pending.length,
        processing: processing.length,
        completed: completed.length,
        failed: failed.length,
        totalSizeMB: allDownloads.reduce((sum, d) => sum + (d.totalSizeMB || 0), 0),
      });
    } catch (error) {
      console.error('[TTSDownloadsScreen] Failed to load downloads:', error);
      showToast('Failed to load downloads');
    }
  };

  const handleDownloadEvent = useCallback((event: DownloadEvent) => {
    if (
      event.type === 'downloadCompleted' ||
      event.type === 'downloadFailed' ||
      event.type === 'queueChanged' ||
      event.type === 'downloadProgress'
    ) {
      loadDownloads();
    }
  }, []);

  const handleDelete = async (download: TTSDownloadRow) => {
    try {
      if (download.status === 'completed' || download.status === 'failed') {
        await ttsDownloadManager.deleteDownload(download.chapterId);
      } else {
        await ttsDownloadManager.cancelDownload(download.chapterId);
      }
      showToast('Download removed');
      loadDownloads();
    } catch (error) {
      console.error('[TTSDownloadsScreen] Delete failed:', error);
      showToast('Failed to remove download');
    }
  };

  const handleClearAll = async () => {
    try {
      await ttsDownloadManager.deleteAllDownloads();
      showToast('All downloads cleared');
      loadDownloads();
    } catch (error) {
      console.error('[TTSDownloadsScreen] Clear all failed:', error);
      showToast('Failed to clear downloads');
    }
  };

  const getStatusText = (download: TTSDownloadRow): string => {
    switch (download.status) {
      case 'pending':
        return 'Pending';
      case 'processing': {
        const progress = download.totalElements > 0
          ? Math.round((download.downloadedElements / download.totalElements) * 100)
          : 0;
        return `Processing ${progress}%`;
      }
      case 'completed':
        return `Completed • ${download.totalSizeMB?.toFixed(1)} MB`;
      case 'failed':
        return `Failed: ${download.errorMessage || 'Unknown error'}`;
      default:
        return download.status;
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'completed':
        return theme.primary;
      case 'failed':
        return theme.error;
      default:
        return theme.onSurfaceVariant;
    }
  };

  const renderDownloadItem = ({ item }: { item: TTSDownloadRow }) => {
    const statusText = getStatusText(item);
    const statusColor = getStatusColor(item.status);
    const createdDate = dayjs(item.createdAt).format('MMM D, YYYY');

    return (
      <Swipeable
        dragOffsetFromRightEdge={30}
        renderRightActions={(_progress, _dragX, ref) => (
          <View style={[styles.deleteAction, { backgroundColor: theme.error }]}>
            <IconButtonV2
              name="delete"
              size={24}
              color={'#fff'}
              onPress={() => {
                ref.close();
                handleDelete(item);
              }}
              theme={theme}
            />
          </View>
        )}
      >
        <List.Item
          title={`Chapter ${item.chapterId}`}
          description={`${statusText}\n${createdDate} • ${item.voiceName}`}
          theme={theme}
        />
      </Swipeable>
    );
  };

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

  const ListHeaderComponent = useCallback(() => {
    if (stats.total === 0) return null;
    return (
      <View style={styles.statsContainer}>
        <List.InfoItem
          title={`${stats.completed} completed • ${stats.processing} processing • ${stats.pending} pending`}
          theme={theme}
        />
        {stats.totalSizeMB > 0 && (
          <List.InfoItem
            title={`Total size: ${stats.totalSizeMB.toFixed(1)} MB`}
            theme={theme}
          />
        )}
      </View>
    );
  }, [stats, theme]);

  useEffect(() => {
    loadDownloads().finally(() => setLoading(false));

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
        <MaterialAppbar.Action
          icon="refresh"
          iconColor={theme.onSurface}
          onPress={() => loadDownloads()}
        />
        {stats.total > 0 && (
          <MaterialAppbar.Action
            icon="delete-sweep"
            iconColor={theme.onSurface}
            onPress={() => setShowClearAllDialog(true)}
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

      <ConfirmationDialog
        visible={showClearAllDialog}
        title="Clear all downloads"
        message="This will delete all downloaded TTS audio files. This cannot be undone."
        onSubmit={handleClearAll}
        onDismiss={() => setShowClearAllDialog(false)}
        theme={theme}
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
  deleteAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 64,
  },
});

export default TTSDownloadsScreen;
