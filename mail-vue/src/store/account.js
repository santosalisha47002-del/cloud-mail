    import { defineStore } from 'pinia'

export const useAccountStore = defineStore('account', {
    state: () => ({
        currentAccountId: 0,
        currentAccount: {},
        changeUserAccountName: '',
        refreshList: 0
    }),
    actions: {
        refreshAccountList() {
            this.refreshList ++
        }
    }
})
