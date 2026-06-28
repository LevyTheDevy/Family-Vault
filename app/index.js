import 'expo-dev-client';
import { install } from 'react-native-quick-crypto';
install();

// require() (not import) so this is evaluated AFTER install() —
// import statements are hoisted and would load crypto.js before install() runs
require('expo/AppEntry');
