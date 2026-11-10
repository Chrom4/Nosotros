import { Redirect, Tabs } from 'expo-router';
import React from 'react';
import { useSessionUIStore } from '@/store';

export default function TabsLayout() {
  const authStatus = useSessionUIStore((s) => s.authStatus);
  const activeHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);

  if (authStatus === 'UNAUTHENTICATED') {
    return <Redirect href="/(auth)/login" />;
  }

  if (authStatus === 'AUTHENTICATED' && !activeHouseholdId) {
    return <Redirect href="/(auth)/create-household" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: '#0F172A' },
        headerTintColor: '#F8FAFC',
        tabBarStyle: {
          backgroundColor: '#1E293B',
          borderTopColor: '#334155',
        },
        tabBarActiveTintColor: '#818CF8',
        tabBarInactiveTintColor: '#94A3B8',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: 'Lançamentos',
        }}
      />
      <Tabs.Screen
        name="accounts"
        options={{
          title: 'Contas',
        }}
      />
      <Tabs.Screen
        name="cards"
        options={{
          title: 'Cartões',
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: 'Faturas',
        }}
      />
      <Tabs.Screen
        name="recurring"
        options={{
          title: 'Recorrentes',
        }}
      />
      <Tabs.Screen
        name="categories"
        options={{
          title: 'Categorias',
        }}
      />
      <Tabs.Screen
        name="settings/backup"
        options={{
          title: 'Backup',
        }}
      />
    </Tabs>
  );
}
