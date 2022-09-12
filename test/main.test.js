const { assert } = require( 'chai' )
const { utils } = require( '@aeternity/aeproject' )
const SDK = require( '@aeternity/aepp-sdk' )

const FACTORY_SOURCE = './contracts/Factory.aes'
const V1_CONTRACT_SOURCE = './contracts/UpgradableContractV1.aes'
const V2_CONTRACT_SOURCE = './contracts/UpgradableContractV2.aes'

let aeSdk
let factory
let v1Contract
let v2ContractModel

// UTILITIES
//const p0 = 'ak_fUq2NesPXcYZ1CcqBcGC3StpdnQw3iVxMA3YSeCNAwfN4myQk'
const p1 = 'ak_tWZrf8ehmY7CyB1JAoBmWJEeThwWnDpU4NadUdzxVSbzDgKjP'
//const p2 = "ak_FHZrEbRmanKUe9ECPXVNTLLpRP2SeQCLCT6Vnvs9JuVu78J7V"
const onAccount = ( p ) => ( {
    onAccount: aeSdk.accounts[p],
} )

const cttoak = ( value ) => value.replace( "ct_", "ak_" )
const getAK = contract => cttoak( contract.deployInfo.address )

const withPlayer = ( player ) => ( opts ) => ( {
    ...( opts || {} ),
    ...onAccount( player )
} )
//const withP0 = withPlayer( p0 )
const withP1 = withPlayer( p1 )
//const withP2 = withPlayer( p2 )

const initFactoryContract = async ( opts = {} ) => {
    aeSdk = await utils.getSdk()

    // a filesystem object must be passed to the compiler if the contract uses custom includes
    const factoryFileSystem = utils.getFilesystem( FACTORY_SOURCE )

    // get content of contract
    const factoryContent = utils.getContractContent( FACTORY_SOURCE )

    // initialize the contract instance
    factory = await aeSdk.getContractInstance( { source: factoryContent, fileSystem: factoryFileSystem } )
    await factory.deploy(
        [], {
            amount: opts.amount || 0,
            ...( opts.onAccount ? { onAccount: opts.onAccount } : {} ),
        }
    )
    
}

const deployNewContract = async ( contractSource ) => {

    // a filesystem object must be passed to the compiler if the contract uses custom includes
    const factoryFileSystem = utils.getFilesystem( contractSource )

    // get content of contract
    const factoryContent = utils.getContractContent( contractSource )

    // initialize the contract instance
    const contract  = await aeSdk.getContractInstance( { source: factoryContent, fileSystem: factoryFileSystem } )
    await contract.deploy( [ 0 ], {} )

    return contract
}

const getContractFromFactory = async( contractSource = V1_CONTRACT_SOURCE ) => {
    const { decodedResult: v1_address } = await factory.methods.get_contract()

    //get v1 contract instance
    // a filesystem object must be passed to the compiler if the contract uses custom includes
    const v1ContractFileSystem = utils.getFilesystem( contractSource )

    // get content of contract
    const v1Content = utils.getContractContent( contractSource )

    return aeSdk.getContractInstance( { source: v1Content, fileSystem: v1ContractFileSystem, contractAddress: v1_address } )
}

const failsWith = async ( f, msg ) => {
    try {
        await f()
    } catch ( err ) {
        assert.include( err.message, msg )
        return
    }
    assert.fail()
}

const rollback = async () => {
    await utils.rollbackSnapshot( aeSdk )
    //console.log( "rolled back" )
}

describe( "main tests", () => {
    before( async () => {
        await initFactoryContract()
        // we are going to store the address of v1 contract for later tests 
        v1Contract = await getContractFromFactory()
        v2ContractModel = await deployNewContract( V2_CONTRACT_SOURCE )

        // create a snapshot of the blockchain state
        await utils.createSnapshot( aeSdk )
    } )

    it( "test v1 contract", async () => {
        const contract = await getContractFromFactory()
        const { decodedResult: value } = await contract.methods.get_version()
        assert.equal( value, "v1" )
    } )
    it( "increase_counter works as supposed", async () => {
        let v1CurrentState
        ;( { decodedResult: v1CurrentState,  } = await v1Contract.methods.get_state() )
        assert.equal( v1CurrentState.counter, 0 )
        assert.equal( v1CurrentState.replaced, false )

        //increase counter
        await v1Contract.methods.increase_counter()
        ;( { decodedResult: v1CurrentState,  } = await v1Contract.methods.get_state() )
        assert.equal( v1CurrentState.counter, 1 )
        assert.equal( v1CurrentState.replaced, false )

        await rollback()
    } )

    it( "just factory can change the contract", async () => {
        await failsWith(
            () => v1Contract.methods.replace_contract(),
            "not the factory"
        )
    } )
    it( "factory accepts only the owner", async () => {
        await failsWith(
            () => factory.methods.change_contract( v2ContractModel.deployInfo.address, withP1( ) ),
            "not the owner"
        )
    } )
    it( "replacing the contract disables the original contract", async () => {
        //replace contract
        await factory.methods.change_contract( v2ContractModel.deployInfo.address )
    
        const { decodedResult: v1CurrentState,  } = await v1Contract.methods.get_state()
        assert.equal( v1CurrentState.replaced, true )

        failsWith(
            () => v1Contract.methods.increase_counter(),
            "already replaced"
        )

        await rollback()
    } )
    it( "new contract has new version", async () => {
        //replace contract
        await factory.methods.change_contract( v2ContractModel.deployInfo.address )
        const contract = await getContractFromFactory( V2_CONTRACT_SOURCE )

        const { decodedResult: value } = await contract.methods.get_version()
        assert.equal( value, "v2" )

        await rollback()
    } )
    it( "the new contract inherits the state from previous version", async () => {
        await v1Contract.methods.increase_counter()
        await v1Contract.methods.increase_counter()

        //replace contract
        await factory.methods.change_contract( v2ContractModel.deployInfo.address )
        const contract = await getContractFromFactory( V2_CONTRACT_SOURCE )

        const { decodedResult: v2CurrentState,  } = await contract.methods.get_state() 

        assert.deepEqual( v2CurrentState, { counter: 2n, replaced: false } )

        await rollback()
    } )

    it( "the new contract gets all the ae from the factory and previous version", async () => {

        const extraAe = 20000n
        const v1Address = getAK( v1Contract )
        const factoryAddress = getAK( factory )
        await aeSdk.spend( extraAe / 2n, v1Address ) // we pay from p2
        await aeSdk.spend( extraAe / 2n, factoryAddress ) // we pay from p2
        
        //replace contract
        await factory.methods.change_contract( v2ContractModel.deployInfo.address )
        const { decodedResult: v2_address } = await factory.methods.get_contract()

        const balance = BigInt( await aeSdk.getBalance( cttoak( v2_address ) ) )
        assert.equal( balance, extraAe )

        await rollback()
    } )

    it( "the new contract can decrease the counter", async () => {
        await v1Contract.methods.increase_counter()
        await v1Contract.methods.increase_counter()

        //replace contract
        await factory.methods.change_contract( v2ContractModel.deployInfo.address )
        const contract = await getContractFromFactory( V2_CONTRACT_SOURCE )

        await contract.methods.decrease_counter( 2 )

        const { decodedResult: v2CurrentState,  } = await contract.methods.get_state() 

        assert.deepEqual( v2CurrentState, { counter: 0n, replaced: false } )

        await rollback()
    } )
} )
