import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import PostSlide from '../components/PostSlide';
import CommentsSheet from '../components/CommentsSheet';
import { fetchPost } from '../utils/api';
import { useTheme } from '../context/ThemeContext';

// Full-screen single post — where notification taps land
export default function PostViewerScreen({ route, navigation }) {
  const { postId } = route.params;
  const { colors } = useTheme();
  const [post, setPost] = useState(null);
  const [error, setError] = useState(null);
  const [commentPost, setCommentPost] = useState(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    fetchPost(postId)
      .then(setPost)
      .catch(() => setError('Could not open this post — it may have been deleted.'));
  }, [postId]);

  return (
    <View style={styles.container} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {error ? (
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: colors.textSub }]}>{error}</Text>
        </View>
      ) : !post || !height ? (
        <View style={styles.center}><ActivityIndicator color="#fff" /></View>
      ) : (
        <PostSlide
          post={post}
          height={height}
          isActive
          onDeleted={() => navigation.goBack()}
          onCommentPress={setCommentPost}
        />
      )}

      {commentPost && (
        <CommentsSheet
          post={commentPost}
          onClose={() => setCommentPost(null)}
          onUpdated={(u) => { setPost(u); setCommentPost((cp) => (cp ? u : cp)); }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorText: { fontSize: 14, textAlign: 'center' },
});
